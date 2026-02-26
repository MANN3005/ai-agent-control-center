import "dotenv/config";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();
const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// TEMP user (we will replace with Auth0 later)
app.use((req, _res, next) => {
  (req as any).userId = "auth0|demo-user";
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

  await prisma.$transaction(ops);
  const updated = await prisma.toolPolicy.findMany({ where: { userId } });
  res.json(updated);
});

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));