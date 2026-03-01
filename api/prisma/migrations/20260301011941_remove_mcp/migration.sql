/*
  Warnings:

  - You are about to drop the `McpServer` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `McpTool` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "McpServer";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "McpTool";
PRAGMA foreign_keys=on;
