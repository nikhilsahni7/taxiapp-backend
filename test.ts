const twilio = require("twilio");

// Your Twilio Account SID and Auth Token
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifySid = process.env.TWILIO_VERIFY_SID;
const client = new twilio(accountSid, authToken);

client.verify.v2
  .services(verifySid)
  .verifications.create({
    to: "+918800244926",
    channel: "sms", // Channel type (SMS or voice)
  })
  .then((verification: { sid: string }) => console.log(verification.sid))
  .catch((error: Error) => console.error("Error sending SMS:", error));
