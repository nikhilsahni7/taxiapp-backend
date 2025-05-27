// src/test/fcmTest.ts
import { 
  sendFcmNotification, 
  sendCallNotification, 
  sendRegularNotification 
} from "../utils/sendFcmNotification";

const fcmToken = "fzhooSoGTfC7NZaaLCVoJs:APA91bGjPrG4kTml0WeUamS7plj3Uz4Id8ADW1kybB7dD8-g8gTzLdr5Pprqxjc6kqPIuKd3CSHHuZex3DOrGQUOt5iQ2ueY1n9LC6ey0XkifwQNKpnD4_M";

// Test 1: Send a call notification (isCalling = true)
console.log("🔔 Sending call notification...");
await sendCallNotification(
  fcmToken,
  "John Doe", // Caller name
  "call_123"  // Call ID (optional)
);

// Test 2: Send a regular notification (isCalling = false)
console.log("📧 Sending regular notification...");
await sendRegularNotification(
  fcmToken,
  "Welcome 🎉",
  "You've successfully integrated FCM with Bun!",
  { action: "test" }
);

// Test 3: Send custom call notification with manual data
console.log("📞 Sending custom call notification...");
await sendFcmNotification(
  fcmToken,
  "Incoming Call",
  "Call from Jane Smith",
  {
    isCalling: "true",           // This is the key!
    callerName: "Jane Smith",
    callId: "call_456",
    callerNumber: "+1234567890",
    callType: "video"
  }
);

// Test 4: Send notification with isCalling false
console.log("💬 Sending message notification...");
await sendFcmNotification(
  fcmToken,
  "New Message",
  "You have a new message from support",
  {
    isCalling: "false",
    messageId: "msg_789",
    senderId: "support"
  }
);