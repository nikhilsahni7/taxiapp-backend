import admin from "./firebase";

export async function sendFcmNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
) {
  try {
    const message: admin.messaging.Message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data: data ?? {},
      // Android specific configuration for call notifications
      android: {
        priority: "high",
        notification: {
          priority: "high",
          channelId: data?.isCalling === "true" ? "call_channel" : "basic_channel",
          // For call notifications, disable default notification
          ...(data?.isCalling === "true" && {
            defaultSound: true,
            defaultVibrateTimings: true,
          }),
        },
      },
      // iOS specific configuration
      apns: {
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: data?.isCalling === "true" ? "default" : "default",
            "content-available": 1,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log("✅ Notification sent:", response);
    return response;
  } catch (error) {
    console.error("❌ Error sending notification:", error);
    throw error;
  }
}

// Helper function specifically for call notifications
export async function sendCallNotification(
  fcmToken: string,
  callerName: string,
  callId?: string
) {
  return sendFcmNotification(
    fcmToken,
    "Incoming Call",
    `Call from ${callerName}`,
    {
      isCalling: "true",
      callerName: callerName,
      callId: callId || Date.now().toString(),
      type: "call",
    }
  );
}

// Helper function for regular notifications
export async function sendRegularNotification(
  fcmToken: string,
  title: string,
  body: string,
  additionalData?: Record<string, string>
) {
  return sendFcmNotification(
    fcmToken,
    title,
    body,
    {
      isCalling: "false",
      type: "regular",
      ...additionalData,
    }
  );
}