// src/utils/sendFcmNotification.ts
import admin from "./firebase";

export async function sendFcmNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<string> {
  try {
    console.log(`\n📤 Sending FCM notification...`);
    console.log(`📱 Token: ${fcmToken.substring(0, 30)}...`);
    console.log(`📋 Title: ${title}`);
    console.log(`📝 Body: ${body}`);

    // Validate FCM token
    if (!fcmToken || fcmToken.trim() === "") {
      throw new Error("FCM token is required");
    }

    // Prepare the data payload - ensure all values are strings
    const notificationData: Record<string, string> = {
      timestamp: Date.now().toString(),
      title: title,
      body: body,
      click_action: "FLUTTER_NOTIFICATION_CLICK",
    };

    // Add custom data if provided, ensuring all values are strings
    if (data) {
      Object.entries(data).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          notificationData[key] = String(value);
        }
      });
    }

    console.log(
      `📦 Complete data payload:`,
      JSON.stringify(notificationData, null, 2)
    );

    // Determine notification type based on data
    const isCalling = notificationData.isCalling === "true";
    const isBooking =
      notificationData.type === "booking_request" ||
      Boolean(notificationData.bookingId && notificationData.pickupLocation);
    const shouldShowAsCard = isCalling || isBooking;

    console.log(
      `🎯 Notification type: ${shouldShowAsCard ? "OVERLAY CARD" : "REGULAR NOTIFICATION"}`
    );
    console.log(`📞 Is calling: ${isCalling}`);
    console.log(`🚖 Is booking: ${isBooking}`);

    // Build the complete FCM message
    const message: admin.messaging.Message = {
      token: fcmToken,

      // CRITICAL: Send all data in data field for Flutter to receive
      data: notificationData,

      // CRITICAL: Always include notification field for background/closed app notifications
      notification: {
        title: title,
        body: body,
      },

      // Android specific configuration
      android: {
        priority: shouldShowAsCard ? "high" : "normal",
        ttl: shouldShowAsCard ? 60000 : 3600000, // 60 seconds for cards, 1 hour for regular

        // CRITICAL: Always include notification field for system tray display
        notification: {
          title: title,
          body: body,
          channelId: shouldShowAsCard ? "booking_channel" : "basic_channel",
          priority: shouldShowAsCard ? "high" : "default",
          defaultSound: true,
          defaultVibrateTimings: true,
          icon: "ic_notification",
          color: "#2196F3",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
          // Add category to help Flutter identify notification type
          tag: shouldShowAsCard ? "booking_request" : "general",
        },

        // Always include data for both types
        data: notificationData,
      },

      // iOS specific configuration
      apns: {
        headers: {
          "apns-priority": shouldShowAsCard ? "10" : "5",
          "apns-push-type": "alert",
        },
        payload: {
          aps: {
            // CRITICAL: Always include alert for background notifications
            alert: {
              title: title,
              body: body,
            },
            sound: "default",
            badge: 1,
            "content-available": 1,
            "mutable-content": 1,
            category: shouldShowAsCard
              ? "BOOKING_CALL_CATEGORY"
              : "GENERAL_CATEGORY",
          },
          // Custom data for iOS
          customData: notificationData,
        },
      },
    };

    console.log(`📬 Final FCM message:`, JSON.stringify(message, null, 2));

    // Send the message
    const response = await admin.messaging().send(message);

    console.log(`✅ FCM notification sent successfully!`);
    console.log(`📬 Message ID: ${response}`);
    console.log(`⏰ Sent at: ${new Date().toLocaleTimeString()}`);
    console.log(
      `🎯 Expected behavior: ${shouldShowAsCard ? "Show as overlay card with timer + progress bars" : "Show in notification bar"}`
    );

    return response;
  } catch (error) {
    console.error(`❌ Error sending FCM notification:`, error);

    // Enhanced error handling with specific error types
    if (error instanceof Error) {
      console.error(`❌ Error details:`);
      console.error(`   Name: ${error.name}`);
      console.error(`   Message: ${error.message}`);

      // Handle specific Firebase errors
      if (error.message.includes("registration-token-not-registered")) {
        console.error("\n🚫 SOLUTION: FCM Token is invalid or expired");
        console.error("   1. Get a new token from your Flutter app");
        console.error("   2. Make sure the app is running on the device");
        console.error("   3. Check if FCM is properly initialized in Flutter");
      } else if (error.message.includes("invalid-argument")) {
        console.error("\n🚫 SOLUTION: Invalid FCM message format");
        console.error("   1. Check all data values are strings");
        console.error("   2. Verify FCM token format");
        console.error("   3. Check message payload structure");
      } else if (error.message.includes("quota-exceeded")) {
        console.error("\n🚫 SOLUTION: FCM quota exceeded");
        console.error("   1. Wait a few minutes before trying again");
        console.error("   2. Check your Firebase plan limits");
      } else if (error.message.includes("authentication-error")) {
        console.error("\n🚫 SOLUTION: Firebase authentication failed");
        console.error("   1. Check your Firebase service account key");
        console.error("   2. Verify project ID is correct");
        console.error("   3. Ensure private key format is correct");
      }
    }

    throw error;
  }
}

// Quick test functions with proper data structure
export async function sendTestBookingNotification(
  fcmToken: string
): Promise<string> {
  const bookingData: Record<string, string> = {
    // CRITICAL: Mark as booking request
    isCalling: "false",
    type: "booking_request",

    // Booking details
    bookingId: `TXS_TEST_${Date.now()}`,
    bookingTitle: "Test Booking Request",
    amount: "₹485",
    distance: "3.2 km",
    duration: "12 min",

    // Locations
    pickupLocation: "Test Pickup Location",
    pickupAddress: "Complete pickup address for testing",
    dropLocation: "Test Drop Location",
    dropAddress: "Complete drop address for testing",

    // Trip details
    rideType: "SUV",
    toPickupDistance: "0.8 km",
    toPickupTime: "4 min",
    tripDistance: "3.2 km",
    tripTime: "12 min",

    // Payment and passenger
    paymentType: "CASH",
    passengerName: "Test User",
    passengerPhone: "+91 99999 88888",
    passengerRating: "4.8",

    // System fields
    userType: "driver",
    priority: "high",
    timestamp: Date.now().toString(),
  };

  return sendFcmNotification(
    fcmToken,
    "New Booking Request 🚖",
    "Test booking request - should show as overlay card with progress bars",
    bookingData
  );
}

export async function sendTestCallNotification(
  fcmToken: string
): Promise<string> {
  const callData: Record<string, string> = {
    // CRITICAL: Mark as call
    isCalling: "true",

    // Call details
    callId: `call_test_${Date.now()}`,
    callerName: "Test Caller",
    callerId: "+91 99999 88888",
    callerImage:
      "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face",
    callType: "audio",

    // Context
    userType: "customer",
    bookingId: "TEST_BOOKING_001",
    callReason: "test_call",
    priority: "high",

    // System fields
    timestamp: Date.now().toString(),
  };

  return sendFcmNotification(
    fcmToken,
    "Test Call 📞",
    "Test call notification - should show as overlay card with progress bars",
    callData
  );
}

export async function sendTestRegularNotification(
  fcmToken: string
): Promise<string> {
  const regularData: Record<string, string> = {
    // CRITICAL: Mark as regular (not call, not booking)
    isCalling: "false",
    type: "general",

    // Content
    category: "test",
    testType: "regular_notification",

    // System fields
    timestamp: Date.now().toString(),
  };

  return sendFcmNotification(
    fcmToken,
    "Test Regular Notification 📢",
    "This should appear in the notification bar (NOT as overlay card)",
    regularData
  );
}

// Enhanced booking notification with all required fields
export async function sendTaxiSureBookingNotification(
  fcmToken: string,
  bookingData: {
    bookingId?: string;
    amount: string;
    pickupLocation: string;
    dropLocation: string;
    distance?: string;
    duration?: string;
    rideType?: string;
    passengerName?: string;
    paymentType?: string;
    toPickupDistance?: string;
    toPickupTime?: string;
    tripDistance?: string;
    tripTime?: string;
    passengerPhone?: string;
    passengerRating?: string;
  }
): Promise<string> {
  const completeBookingData: Record<string, string> = {
    // CRITICAL: Booking identification
    isCalling: "false",
    type: "booking_request",

    // Required booking fields
    bookingId: bookingData.bookingId || `TXS_${Date.now()}`,
    bookingTitle: "New Booking Request",
    amount: bookingData.amount,
    distance: bookingData.distance || "0 km",
    duration: bookingData.duration || "0 min",

    // Locations (REQUIRED for booking detection)
    pickupLocation: bookingData.pickupLocation,
    dropLocation: bookingData.dropLocation,
    pickupAddress: `${bookingData.pickupLocation} - Complete address`,
    dropAddress: `${bookingData.dropLocation} - Complete address`,

    // Trip details
    rideType: bookingData.rideType || "SUV",
    toPickupDistance: bookingData.toPickupDistance || "0.5 km",
    toPickupTime: bookingData.toPickupTime || "3 min",
    tripDistance: bookingData.tripDistance || bookingData.distance || "0 km",
    tripTime: bookingData.tripTime || bookingData.duration || "0 min",

    // Payment and passenger
    paymentType: bookingData.paymentType || "CASH",
    passengerName: bookingData.passengerName || "Customer",
    passengerPhone: bookingData.passengerPhone || "+91 99999 99999",
    passengerRating: bookingData.passengerRating || "4.5",

    // System fields
    userType: "driver",
    priority: "high",
    estimatedEarning: `₹${Math.round(parseFloat(bookingData.amount.replace("₹", "")) * 0.8)}`,
    timestamp: Date.now().toString(),
  };

  return sendFcmNotification(
    fcmToken,
    "New Booking Request 🚖",
    `${bookingData.amount} • ${bookingData.distance || "Distance unknown"} • ${bookingData.passengerName || "Customer"}`,
    completeBookingData
  );
}

// Enhanced call notification with all required fields
export async function sendTaxiSureCallNotification(
  fcmToken: string,
  callerName: string,
  callerPhone: string,
  options: {
    callId?: string;
    callType?: "audio" | "video";
    userType?: "customer" | "driver" | "vendor" | "support" | "emergency";
    bookingId?: string;
    callerImage?: string;
    priority?: "low" | "medium" | "high" | "urgent";
    callReason?: string;
    additionalData?: Record<string, string>;
  } = {}
): Promise<string> {
  const completeCallData: Record<string, string> = {
    // CRITICAL: Call identification
    isCalling: "true",

    // Call details
    callId: options.callId || `call_${Date.now()}`,
    callerName: callerName,
    callerId: callerPhone,
    callerImage: options.callerImage || "",
    callType: options.callType || "audio",

    // Context
    userType: options.userType || "customer",
    bookingId: options.bookingId || "",
    priority: options.priority || "high",
    callReason: options.callReason || "general_call",

    // System fields
    timestamp: Date.now().toString(),
  };

  // Add additional data if provided
  if (options.additionalData) {
    Object.entries(options.additionalData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        completeCallData[key] = String(value);
      }
    });
  }

  const title =
    options.userType === "emergency" ? "Emergency Call 🚨" : "Incoming Call 📞";
  const body = `${callerName} is calling you`;

  return sendFcmNotification(fcmToken, title, body, completeCallData);
}

// Regular notification with proper structure
export async function sendTaxiSureRegularNotification(
  fcmToken: string,
  title: string,
  body: string,
  notificationType:
    | "general"
    | "promotion"
    | "booking_confirmed"
    | "payment_success"
    | "ride_started"
    | "driver_arrived"
    | "rating_request",
  additionalData?: Record<string, string>
): Promise<string> {
  const completeRegularData: Record<string, string> = {
    // CRITICAL: Regular notification identification
    isCalling: "false",
    type: notificationType,

    // System fields
    priority: "normal",
    timestamp: Date.now().toString(),
  };

  // Add additional data if provided
  if (additionalData) {
    Object.entries(additionalData).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        completeRegularData[key] = String(value);
      }
    });
  }

  return sendFcmNotification(fcmToken, title, body, completeRegularData);
}

// Validation functions
export function validateFcmToken(token: string): boolean {
  if (!token || typeof token !== "string") {
    console.error("❌ FCM token is not a valid string");
    return false;
  }

  const isValidLength = token.length > 100 && token.length < 200;
  const hasValidFormat =
    token.includes(":") && (token.includes("APA91b") || token.includes("AAAA"));

  if (!isValidLength) {
    console.error(
      "❌ FCM token length is invalid (should be 100-200 characters)"
    );
  }

  if (!hasValidFormat) {
    console.error(
      "❌ FCM token format is invalid (should contain ':' and 'APA91b' or 'AAAA')"
    );
  }

  return isValidLength && hasValidFormat;
}

// Test FCM connection
export async function testFcmConnection(fcmToken: string): Promise<boolean> {
  try {
    console.log("🔍 Testing FCM connection...");
    await sendTestRegularNotification(fcmToken);
    console.log("✅ FCM connection test successful!");
    return true;
  } catch (error) {
    console.error("❌ FCM connection test failed:", error);
    return false;
  }
}

// Test execution when file is run directly
if (import.meta.main) {
  const testFcmToken =
    "fyzzIZFLQQyLJpgMIHBL2d:APA91bHAZs1aDkBAC0MGiQJ6SJiOVAYuKzXvbTJ-iE17hKlwjAaQIbd939FC0B7KaBkguTPZF4_X-A80Pf_KmQDH1FOFxoXdil9Wq2xmxfHTFeIYxFIQKi8";

  console.log("🚀 Testing FCM Notifications with provided token...\n");

  // Validate the token first
  console.log("🔍 Validating FCM token...");
  const isValid = validateFcmToken(testFcmToken);
  console.log(
    `Token validation result: ${isValid ? "✅ VALID" : "❌ INVALID"}\n`
  );

  if (!isValid) {
    console.log("❌ Token validation failed. Please check the token format.");
    process.exit(1);
  }

  // Test different notification types
  async function runTests() {
    try {
      console.log("📱 Testing Regular Notification...");
      await sendTestRegularNotification(testFcmToken);
      console.log("✅ Regular notification sent!\n");

      console.log("🚖 Testing Booking Notification...");
      await sendTestBookingNotification(testFcmToken);
      console.log("✅ Booking notification sent!\n");

      console.log("📞 Testing Call Notification...");
      await sendTestCallNotification(testFcmToken);
      console.log("✅ Call notification sent!\n");

      console.log("🎉 All FCM tests completed successfully!");
    } catch (error) {
      console.error("❌ Test failed:", error);
      process.exit(1);
    }
  }

  runTests();
}
