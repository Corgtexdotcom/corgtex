-- CreateTable
CREATE TABLE "InstanceRegistry" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "notes" TEXT,
    "lastHealthCheck" TIMESTAMP(3),
    "lastHealthStatus" TEXT,
    "lastHealthError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstanceRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstanceRegistry_url_key" ON "InstanceRegistry"("url");
