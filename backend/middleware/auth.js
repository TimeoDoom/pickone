const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  const authHeader = req.header("Authorization");
  if (!authHeader)
    return res.status(401).json({ error: "Accès refusé. Aucun jeton fourni." });

  const token = authHeader.split(" ")[1];
  if (!token)
    return res.status(401).json({ error: "Format de jeton invalide." });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    // 401 pour que le front sache qu'il doit se reconnecter
    res.status(401).json({ error: "Jeton invalide ou expiré." });
  }
};
