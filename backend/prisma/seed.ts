import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be configured before seeding");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  const vendor = await prisma.vendor.upsert({
    where: { slug: "sample-vendor" },
    update: {},
    create: { name: "Sample Vendor", slug: "sample-vendor", email: "catalogue@example.com" },
  });
  const sampleProducts = [
    {
      sku: "AMD-DESK-001",
      title: "Adjustable Standing Desk",
      description: "Height-adjustable desk with a bamboo top.",
      category: "Office Furniture",
      price: "349.99",
      currency: "USD",
      attributes: { color: "Natural", material: "Bamboo" },
    },
    {
      sku: "AMD-LAMP-002",
      title: "LED Desk Lamp",
      description: "Dimmable LED task lamp with USB charging.",
      category: "Lighting",
      price: "54.5",
      currency: "USD",
      attributes: { color: "Black", dimmable: true },
    },
  ];

  for (const product of sampleProducts) {
    await prisma.product.upsert({
      where: { vendorId_sku: { vendorId: vendor.id, sku: product.sku } },
      update: {},
      create: { ...product, vendorId: vendor.id },
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error("Database seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
