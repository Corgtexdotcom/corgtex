import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log("Checking migration health...");
  try {
    // 1. Check for blocked/rolled back migrations
    const failedMigrationsRaw = await prisma.$queryRaw`
      SELECT migration_name FROM _prisma_migrations 
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    
    const failedMigrations = failedMigrationsRaw;

    if (failedMigrations && failedMigrations.length > 0) {
      console.error("❌ FAILED: Blocked/failed migrations found:");
      failedMigrations.forEach(m => console.error(`   - ${m.migration_name}`));
      process.exit(1);
    }
    
    // 2. Check for presence of recent tables/columns to ensure migration ran
    const columnsCheckRaw = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'Circle' AND column_name = 'maturityStage'
    `;
    const columnsCheck = columnsCheckRaw;

    if (columnsCheck.length === 0) {
      console.error("❌ FAILED: 'Circle.maturityStage' column missing! Schema drift detected.");
      process.exit(1);
    }
    
    // 3. Test basic critical table queries
    await prisma.circle.findFirst();
    await prisma.crmDeal.findFirst(); // from recent CRM models migration
    
    console.log("✅ OK: Migrations applied successfully, schema is healthy.");
    process.exit(0);
  } catch (err) {
    if (err.message?.includes('does not exist')) {
       console.error("❌ FAILED: A required table/column does not exist. Schema drift detected:", err.message);
       process.exit(1);
    }
    console.error("❌ Error checking migration health:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
