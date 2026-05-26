import { handleSupportQuestion } from "../src/bot/handlers/support.ts";

const result = await handleSupportQuestion("what is my balance", 6545367105);
console.log("Result:", result);
