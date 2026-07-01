const express = require("express");
const app = express();

app.use(express.json());

// Vulnerability: Hardcoded secret
const DB_PASSWORD = "admin123";

// Vulnerability: SQL Injection via string concatenation
app.get("/users", (req, res) => {
  const userId = req.query.id;
  const query = "SELECT * FROM users WHERE id = '" + userId + "'";
  res.json({ query });
});

// Vulnerability: Path traversal
app.get("/files", (req, res) => {
  const filePath = __dirname + "/" + req.query.name;
  res.sendFile(filePath);
});

app.listen(3000);
