import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { auth } from "express-oauth2-jwt-bearer";

const prisma = new PrismaClient();
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const checkJwt = auth({
  issuerBaseURL: `https://${process.env.AUTH0_DOMAIN}`,
  audience: process.env.AUTH0_AUDIENCE,
});

app.use(checkJwt);

app.use((req, _res, next) => {
  const authReq = req as any;
  authReq.userId = authReq.auth?.payload?.sub;
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/me", (req, res) => {
  res.json({ userId: (req as any).userId });
});

app.get("/policies", async (req, res) => {
  const userId = (req as any).userId as string;
  const policies = await prisma.toolPolicy.findMany({ where: { userId } });
  res.json(policies);
});

app.get("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const provider = String(req.query.provider || "github");
  const resourceType = String(req.query.resourceType || "repo");

  const items = await prisma.allowedResource.findMany({
    where: { userId, provider: provider as any, resourceType },
    orderBy: { createdAt: "desc" },
  });

  res.json(items.map((i) => i.resourceId));
});
const PutPoliciesBody = z.object({
  policies: z.array(
    z.object({
      toolName: z.string().min(1),
      riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
      mode: z.enum(["AUTO", "CONFIRM", "STEP_UP"]),
    })
  ),
});

app.put("/policies", async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = PutPoliciesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const ops = parsed.data.policies.map((p) =>
    prisma.toolPolicy.upsert({
      where: { userId_toolName: { userId, toolName: p.toolName } },
      update: { riskLevel: p.riskLevel as any, mode: p.mode as any },
      create: {
        userId,
        toolName: p.toolName,
        riskLevel: p.riskLevel as any,
        mode: p.mode as any,
      },
    })
  );

  app.get("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const provider = String(req.query.provider || "github");
  const resourceType = String(req.query.resourceType || "repo");

  const items = await prisma.allowedResource.findMany({
    where: { userId, provider: provider as any, resourceType },
    orderBy: { createdAt: "desc" },
  });

  res.json(items.map((i) => i.resourceId));
});

// ===== Allowed Resources =====

app.get("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const provider = String(req.query.provider || "github");
  const resourceType = String(req.query.resourceType || "repo");

  const items = await prisma.allowedResource.findMany({
    where: { userId, provider: provider as any, resourceType },
    orderBy: { createdAt: "desc" },
  });

  res.json(items.map((i) => i.resourceId));
});

const PutAllowedBody = z.object({
  provider: z.enum(["github"]),
  resourceType: z.string().min(1),
  resources: z.array(z.string().min(1)),
});

app.put("/allowed-resources", async (req, res) => {
  const userId = (req as any).userId as string;
  const parsed = PutAllowedBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);

  const { provider, resourceType, resources } = parsed.data;

  await prisma.allowedResource.deleteMany({
    where: { userId, provider: provider as any, resourceType },
  });

  if (resources.length) {
    await prisma.allowedResource.createMany({
      data: resources.map((r) => ({
        userId,
        provider: provider as any,
        resourceType,
        resourceId: r,
      })),
    });
  }

  res.json({ ok: true, count: resources.length });
});

  await prisma.$transaction(ops);
  const updated = await prisma.toolPolicy.findMany({ where: { userId } });
  res.json(updated);
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));