const path = require("path");
const express = require("express");
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.json({ ok: true, service: "fallback" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(4321, () => console.log("up"));
