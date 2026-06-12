import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8087);
const logsDir = join(root, "resultados");

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy();
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function formatLog(payload) {
  const lines = [
    "Bingo Online 2026 - Rotary Club Rukapillan - Log de resultados",
    `Guardado: ${payload.savedAt}`,
    `Total: ${payload.totalResults}`,
    "",
  ];

  if (!payload.results.length) {
    lines.push("Sin resultados antes del reinicio.");
  } else {
    for (const item of payload.results) {
      lines.push(`${String(item.order).padStart(2, "0")}. ${item.result}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function timestampForFile(isoDate) {
  return isoDate.replace(/[:.]/g, "-");
}

createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/log-results") {
    try {
      const payload = JSON.parse(await readBody(request));
      const savedAt = typeof payload.savedAt === "string" ? payload.savedAt : new Date().toISOString();
      const results = Array.isArray(payload.results) ? payload.results : [];
      const normalizedPayload = {
        savedAt,
        totalResults: Number(payload.totalResults) || results.length,
        results,
      };
      const filename = `sorteo-${timestampForFile(savedAt)}.txt`;

      await mkdir(logsDir, { recursive: true });
      await writeFile(join(logsDir, filename), formatLog(normalizedPayload), "utf8");

      response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, file: `resultados/${filename}` }));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  const requestedPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  const safePath =
    requestedPath === "/"
      ? "index.html"
      : normalize(requestedPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("No encontrado");
    return;
  }

  response.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Bingo Online 2026 - Rotary Club Rukapillan: http://localhost:${port}`);
});
