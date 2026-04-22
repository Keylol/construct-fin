import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, "dist");
const API_ORIGIN = process.env.CONSTRUCT_API_ORIGIN || "http://127.0.0.1:8080";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8081);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function proxyRequest(req, res) {
  const target = new URL(req.url, API_ORIGIN);
  const transport = target.protocol === "https:" ? https : http;

  const proxy = transport.request(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ detail: `API proxy error: ${error.message}` }));
  });

  req.pipe(proxy);
}

function sendFile(res, absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] || "application/octet-stream",
    "cache-control": extension === ".html" ? "no-cache" : "public, max-age=300",
  });
  createReadStream(absolutePath).pipe(res);
}

async function resolveAssetPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const absolutePath = path.join(DIST_DIR, relativePath);
  if (!absolutePath.startsWith(DIST_DIR)) {
    return null;
  }
  if (!existsSync(absolutePath)) {
    return path.join(DIST_DIR, "index.html");
  }
  const info = await stat(absolutePath);
  return info.isDirectory() ? path.join(absolutePath, "index.html") : absolutePath;
}

if (!existsSync(path.join(DIST_DIR, "index.html"))) {
  console.error("dist/index.html не найден. Сначала выполните npm run build.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestPath = req.url || "/";
    if (requestPath.startsWith("/api/") || requestPath === "/healthz") {
      proxyRequest(req, res);
      return;
    }

    const assetPath = await resolveAssetPath(requestPath);
    if (!assetPath) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }
    sendFile(res, assetPath);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Server error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`miniapp_web production server listening on http://${HOST}:${PORT}`);
  console.log(`proxying API to ${API_ORIGIN}`);
});
