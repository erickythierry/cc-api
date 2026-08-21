import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface RenewOptions {
  chromePath?: string;
  userDataDir?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }> | string;
  headless?: boolean;
  timeoutMs?: number;
  authFilePath?: string;
}

export interface AuthResult {
  apiKey: string;
  userId: string;
  userName: string;
  keyName: string;
  authenticatedAt: string;
}

class CdpClient {
  private ws: WebSocket;
  private msgId = 1;
  private pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id)!;
          this.pending.delete(data.id);
          if (data.error) {
            reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            resolve(data.result);
          }
        }
      } catch {}
    });
  }

  static async connect(port: number): Promise<CdpClient> {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No CDP page target available");
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("CDP WebSocket connection failed"));
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

export async function renewToken(opts: RenewOptions = {}): Promise<AuthResult> {
  const chromePath =
    opts.chromePath ||
    process.env.CHROME_BIN ||
    (os.platform() === "linux" ? (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : "/usr/bin/google-chrome") : "google-chrome");
  const userDataDir = opts.userDataDir || process.env.BROWSER_DATA_DIR || path.join(os.homedir(), ".commandcode", "browser-data");
  const authFile = opts.authFilePath || path.join(os.homedir(), ".commandcode", "auth.json");
  const headless = opts.headless !== false;
  const timeoutMs = opts.timeoutMs || 60000;

  const state = crypto.randomBytes(32).toString("base64url");
  const cdpPort = 9222 + Math.floor(Math.random() * 500);

  let resolveAuth: (val: AuthResult) => void;
  let rejectAuth: (err: Error) => void;
  const authPromise = new Promise<AuthResult>((res, rej) => {
    resolveAuth = res;
    rejectAuth = rej;
  });

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === "/callback" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.state !== state) {
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, error: "Invalid state" }));
          }

          const credentials: AuthResult = {
            apiKey: data.apiKey,
            userId: data.userId || "",
            userName: data.userName || "",
            keyName: data.keyName || "",
            authenticatedAt: new Date().toISOString(),
          };

          fs.mkdirSync(path.dirname(authFile), { recursive: true });
          fs.writeFileSync(authFile, JSON.stringify(credentials, null, 2));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          resolveAuth(credentials);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Malformed payload" }));
          rejectAuth(e instanceof Error ? e : new Error(String(e)));
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const callbackPort = (server.address() as any).port;
  const authUrl = `https://commandcode.ai/studio/auth/cli?callback=${encodeURIComponent(`http://localhost:${callbackPort}/callback`)}&state=${encodeURIComponent(state)}`;

  // Launch Chrome
  const chromeArgs = [
    headless ? "--headless=new" : "",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-extensions",
    "--disable-web-security",
    "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ].filter(Boolean);

  const chromeProc = spawn(chromePath, chromeArgs, { stdio: "ignore" });

  const timer = setTimeout(() => {
    rejectAuth(new Error(`Authentication timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let cdp: CdpClient | null = null;

  try {
    // Wait for CDP to become ready
    let connected = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        cdp = await CdpClient.connect(cdpPort);
        connected = true;
        break;
      } catch {}
    }

    if (!connected || !cdp) {
      throw new Error("Could not connect to Chrome DevTools Protocol");
    }

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    // Injeta cookies se fornecidos via opção ou env CC_COOKIES
    const rawCookies = opts.cookies || process.env.CC_COOKIES;
    if (rawCookies) {
      try {
        let cookieList: Array<{ name: string; value: string; domain?: string; path?: string }> = [];
        if (typeof rawCookies === "string") {
          if (rawCookies.trim().startsWith("[") || rawCookies.trim().startsWith("{")) {
            const parsed = JSON.parse(rawCookies);
            cookieList = Array.isArray(parsed) ? parsed : [parsed];
          } else {
            // Formato cookie header string: "name1=val1; name2=val2"
            cookieList = rawCookies.split(";").map((pair) => {
              const [name, ...rest] = pair.trim().split("=");
              return { name, value: rest.join("="), domain: "commandcode.ai", path: "/" };
            });
          }
        } else if (Array.isArray(rawCookies)) {
          cookieList = rawCookies;
        }

        for (const c of cookieList) {
          if (!c.name || !c.value) continue;
          await cdp.send("Network.setCookie", {
            name: c.name,
            value: c.value,
            domain: c.domain || ".commandcode.ai",
            path: c.path || "/",
            secure: true,
            httpOnly: false,
          });
        }
      } catch (e) {
        console.warn("[renew] Failed to parse/set cookies:", e instanceof Error ? e.message : e);
      }
    }

    await cdp.send("Page.navigate", { url: authUrl });

    // Loop polling page state and clicking authorize if present
    const pollInterval = setInterval(async () => {
      if (!cdp) return;
      try {
        // Check current URL and DOM
        const urlEval = await cdp.send("Runtime.evaluate", { expression: "window.location.href" });
        const currentUrl = urlEval.result?.value || "";

        if (currentUrl.includes("/signin")) {
          clearInterval(pollInterval);
          rejectAuth(new Error("Browser is not logged into commandcode.ai. Login required in browser-data profile."));
          return;
        }

        // Try clicking the Authorize button
        const clickEval = await cdp.send("Runtime.evaluate", {
          expression: `
            (() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const authorizeBtn = buttons.find(b => b.textContent && b.textContent.includes('Authorize'));
              if (authorizeBtn && !authorizeBtn.disabled) {
                authorizeBtn.click();
                return 'clicked';
              }
              return 'waiting';
            })()
          `,
        });
      } catch {}
    }, 1000);

    const result = await authPromise;
    clearInterval(pollInterval);
    return result;
  } finally {
    clearTimeout(timer);
    try {
      cdp?.close();
    } catch {}
    try {
      chromeProc.kill();
    } catch {}
    try {
      server.close();
    } catch {}
  }
}
