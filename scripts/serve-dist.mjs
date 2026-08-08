import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "build");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = normalize(pathname).replace(/^([/\\])+/, "");
    let file = join(root, relative || "index.html");
    if (!extname(file)) file = join(root, "index.html");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    try {
      response.writeHead(200, { "content-type": types[".html"] });
      response.end(await readFile(join(root, "index.html")));
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  }
}).listen(4173, "0.0.0.0", () => {
  console.log("TBA preview: http://0.0.0.0:4173");
});
