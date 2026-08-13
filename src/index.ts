import "dotenv/config";

async function main(): Promise<void> {
  console.log("pipeline starting");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
