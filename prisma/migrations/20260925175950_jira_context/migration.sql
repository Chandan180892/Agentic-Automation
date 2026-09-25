-- AlterTable
ALTER TABLE "Story" ADD COLUMN     "contextJson" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "importedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "testLinkType" TEXT NOT NULL DEFAULT 'Test';
