-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
