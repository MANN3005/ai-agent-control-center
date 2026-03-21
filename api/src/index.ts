import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { auth } from "express-oauth2-jwt-bearer";
import { corsOrigin } from "./config";
import { registerRoutes } from "./routes";
import registerSlackEvents from "./slack-events";
import { resolveCanonicalAuth0UserId } from "./services/auth0";

const app = express();

// Render sits behind a proxy/load balancer; trust first hop for real client IP.
app.set("trust proxy", 1);

app.use(cors({ origin: corsOrigin, credentials: true }));

registerSlackEvents(app);

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

// Keep health checks public so hosting platforms can verify liveness.
app.get("/health", (_req, res) => res.json({ ok: true }));

const checkJwt = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  audience: process.env.AUTH0_AUDIENCE,
});

app.use(checkJwt);

app.use(async (req, _res, next) => {
  const r = req as any;
  const sub = String(r.auth?.payload?.sub || "").trim();
  const emailClaim = r.auth?.payload?.email;
  const email = typeof emailClaim === "string" ? emailClaim : null;
  r.userEmail = email;

  if (!sub) {
    r.userId = null;
    next();
    return;
  }

  try {
    r.userId = await resolveCanonicalAuth0UserId(sub, email);
  } catch {
    // Fall back to token subject if management lookup fails.
    r.userId = sub;
  }

  next();
});

registerRoutes(app);

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.status === 401 || err?.name === "UnauthorizedError") {
    return res.status(401).json({ status: "unauthorized" });
  }
  return next(err);
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
