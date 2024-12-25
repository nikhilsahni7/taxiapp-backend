// // test.ts
// import twilio from "twilio";

// const client = twilio(
//   process.env.TWILIO_ACCOUNT_SID,
//   process.env.TWILIO_AUTH_TOKEN
// );

// async function testTwilio() {
//   try {
//     const message = await client.messages.create({
//       body: "Test message from my backend",
//       from: process.env.TWILIO_PHONE_NUMBER,
//       to: "+918800244926",
//     });
//     console.log("Test successful:", message.sid);
//   } catch (error) {
//     console.error("Test failed:", error);
//   }
// }

// testTwilio();

import * as crypto from "crypto";

function generateRazorpaySignature(
  orderId: string,
  paymentId: string,
  secret: string
): string {
  const message = `${orderId}|${paymentId}`;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Example Usage
const orderId = "order_PaDSLZK5ihMO71";
const paymentId = "pay_JhsF12345abcdEF";
const secret = process.env.RAZORPAY_KEY_SECRET!;

const signature = generateRazorpaySignature(orderId, paymentId, secret);
console.log("Generated Signature:", signature);
