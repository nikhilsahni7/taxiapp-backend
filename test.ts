// test.ts
import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function testTwilio() {
  try {
    const message = await client.messages.create({
      body: "Test message from my backend",
      from: process.env.TWILIO_PHONE_NUMBER,
      to: "+918800244926",
    });
    console.log("Test successful:", message.sid);
  } catch (error) {
    console.error("Test failed:", error);
  }
}

testTwilio();
