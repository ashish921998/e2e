import http from "node:http";
import net from "node:net";
import process from "node:process";
import type { PortsFile } from "./ports.js";

export const PROXY_PORT_RANGE_START = 8080;
export const PROXY_PORT_RANGE_END = 8089;

/**
 * Extract the rift name from a Host header.
 * Strips :port and .localhost. Returns null for non-localhost hosts.
 */
export function riftNameFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const noPort = host.split(":")[0];
  if (!noPort.endsWith(".localhost")) return null;
  return noPort.slice(0, -".localhost".length);
}

/** Pick the first free proxy port from 8080..8089. */
export function pickProxyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > PROXY_PORT_RANGE_END) {
        reject(new Error(`no free proxy port in ${PROXY_PORT_RANGE_START}..${PROXY_PORT_RANGE_END}`));
        return;
      }
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => tryPort(port + 1));
      srv.listen(port, () => srv.close(() => resolve(port)));
    };
    tryPort(PROXY_PORT_RANGE_START);
  });
}

export interface StartProxyOpts {
  port: number;
  ports: PortsFile;
}

export interface ProxyHandle {
  close: () => void;
  port: number;
}

/**
 * Start the reverse proxy. Routes Host: <name>.localhost → that rift's port.
 */
export function startProxy(opts: StartProxyOpts): Promise<ProxyHandle> {
  const { port, ports } = opts;
  const server = http.createServer((req, res) => {
    const name = riftNameFromHost(req.headers.host);
    if (!name) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end(`rifts: no rift resolved from Host header\n`);
      return;
    }
    const entry = ports.rifts[name];
    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end(`rifts: unknown rift "${name}"\n`);
      return;
    }

    const proxyReq = http.request(
      {
        host: "127.0.0.1",
        port: entry.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on("error", (err) => {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain");
      res.end(
        `rifts: upstream ${name} (port ${entry.port}) unreachable: ${err.message}\n`,
      );
    });
    req.pipe(proxyReq);
  });

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}

/** Run the proxy as a foreground process until SIGINT. */
export async function runProxyServer(ports: PortsFile): Promise<void> {
  const port = await pickProxyPort();
  const handle = await startProxy({ port, ports });
  console.log(`rifts proxy listening on http://127.0.0.1:${handle.port}`);
  console.log(`  preview rifts at http://<rift-name>.localhost:${handle.port}`);
  process.on("SIGINT", () => {
    handle.close();
    process.exit(0);
  });
  // Keep alive until killed.
  await new Promise<void>(() => {});
}
