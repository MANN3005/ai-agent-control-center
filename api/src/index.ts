import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { auth } from "express-oauth2-jwt-bearer";
import { corsOrigin } from "./config";
import { registerRoutes } from "./routes";

const app = express();

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 25,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);
app.use("/agent", agentLimiter);

const checkJwt = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  audience: process.env.AUTH0_AUDIENCE,
});

app.use(checkJwt);

app.use((req, _res, next) => {
  const r = req as any;
  r.userId = r.auth?.payload?.sub;
  next();
});

registerRoutes(app);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
