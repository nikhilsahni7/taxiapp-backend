// src/test/comprehensiveFcmTests.ts
import { 
  sendFcmNotification,
  sendTestBookingNotification,
  sendTestCallNotification,
  sendTestRegularNotification,
  sendTaxiSureBookingNotification,
  sendTaxiSureCallNotification,
  sendTaxiSureRegularNotification,
  validateFcmToken,
  testFcmConnection
} from "../utils/sendFcmNotification";

const fcmToken = "c44fQKGoSc6cv9-Uj3Pm3m:APA91bGb5mOb3zBdcVaFZkxIm3ZFjKrtplcFHQGcJnswkYSXKCJcd7Ht7vUDlWSyjWUzBLrpyT9roC8ooKB_TGpRqv02OnDPSaJOG4WYwZHa4OQbTGpAZfU";

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to log test status
function logTest(testNumber: number, description: string, status: 'start' | 'success' | 'error', error?: any) {
  const timestamp = new Date().toLocaleTimeString();
  switch (status) {
    case 'start':
      console.log(`\n🧪 Test ${testNumber}: ${description}`);
      console.log(`⏰ Started at: ${timestamp}`);
      break;
    case 'success':
      console.log(`✅ Test ${testNumber} completed successfully at ${timestamp}`);
      break;
    case 'error':
      console.log(`❌ Test ${testNumber} failed at ${timestamp}:`, error?.message || error);
      break;
  }
}

async function runComprehensiveTests() {
  console.log("🚀 Starting Comprehensive TaxiSure FCM Tests v2.0");
  console.log("=".repeat(60));
  console.log("📱 Testing all notification types with enhanced data structure");
  console.log("🔍 Verifying: Overlay Cards vs Regular notifications");
  console.log("⏱️  Testing: Timer with dual progress bars (circular + linear)");
  console.log("📚 Testing: Multiple card stacking without overlap");
  console.log("=".repeat(60));

  // Validate FCM token first
  if (!validateFcmToken(fcmToken)) {
    console.error("❌ Invalid FCM token. Please update your token and try again.");
    return;
  }

  // Test connection
  const connectionWorks = await testFcmConnection(fcmToken);
  if (!connectionWorks) {
    console.error("❌ FCM connection failed. Please check your configuration.");
    return;
  }

  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Test 1: Regular General Notification (Should show in notification bar)
    logTest(1, "Regular General Notification", 'start');
    try {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "TaxiSure Update 📢",
        "App has been updated with new features including progress bars and enhanced timers",
        "general",
        {
          category: "app_update",
          version: "2.1.0",
          features: "Progress bars, Enhanced timers, Better UI",
          priority: "normal"
        }
      );
      testsPassed++;
      logTest(1, "Regular General Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(1, "Regular General Notification", 'error', error);
    }
    await delay(3000);

    // Test 2: Regular Promotional Notification
    logTest(2, "Promotional Notification", 'start');
    try {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "Special Offer! 🎉",
        "Get 25% off on your next 3 rides. Use code: SAVE25",
        "promotion",
        {
          discount: "25",
          promoCode: "SAVE25",
          validTill: "2024-12-31",
          maxUses: "3",
          minAmount: "₹200"
        }
      );
      testsPassed++;
      logTest(2, "Promotional Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(2, "Promotional Notification", 'error', error);
    }
    await delay(3000);

    // Test 3: Audio Call Notification (Should show as overlay card)
    logTest(3, "Audio Call Notification", 'start');
    try {
      await sendTaxiSureCallNotification(
        fcmToken,
        "Rajesh Kumar",
        "+91 98765 43210",
        {
          callType: "audio",
          userType: "customer",
          bookingId: "TXS001234",
          callerImage: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face",
          callReason: "pickup_location_query",
          priority: "high",
          additionalData: {
            urgency: "medium",
            estimatedDuration: "2-3 minutes"
          }
        }
      );
      testsPassed++;
      logTest(3, "Audio Call Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(3, "Audio Call Notification", 'error', error);
    }
    await delay(5000); // Wait to see the card with progress bars

    // Test 4: Video Call Notification (Should show as overlay card)
    logTest(4, "Video Call Notification", 'start');
    try {
      await sendTaxiSureCallNotification(
        fcmToken,
        "Suresh Singh (Driver)",
        "+91 87654 32109",
        {
          callType: "video",
          userType: "driver",
          bookingId: "TXS005678",
          callerImage: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face",
          callReason: "pickup_confirmation",
          priority: "high",
          additionalData: {
            vehicleNumber: "DL 01 AB 1234",
            driverRating: "4.8",
            estimatedArrival: "3 minutes"
          }
        }
      );
      testsPassed++;
      logTest(4, "Video Call Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(4, "Video Call Notification", 'error', error);
    }
    await delay(5000);

    // Test 5: Premium Booking Request (Should show as overlay card)
    logTest(5, "Premium Booking Request", 'start');
    try {
      await sendTaxiSureBookingNotification(fcmToken, {
        bookingId: `TXS_PREMIUM_${Date.now()}`,
        amount: "₹2891",
        pickupLocation: "NZ/9/3185, Raj Nagar, New Delhi, 110077",
        dropLocation: "Panipat, Haryana, India",
        distance: "101.5 km",
        duration: "130 min",
        rideType: "SUV",
        toPickupDistance: "0.6 km",
        toPickupTime: "4 min",
        tripDistance: "101.5 km",
        tripTime: "130 min",
        paymentType: "CASH",
        passengerName: "shweta",
        passengerPhone: "+91 99999 88888",
        passengerRating: "4.9"
      });
      testsPassed++;
      logTest(5, "Premium Booking Request", 'success');
    } catch (error) {
      testsFailed++;
      logTest(5, "Premium Booking Request", 'error', error);
    }
    await delay(8000); // Wait to see booking card with progress bars

    // Test 6: Economy Booking Request (For stacking test)
    logTest(6, "Economy Booking Request (Stacking)", 'start');
    try {
      await sendTaxiSureBookingNotification(fcmToken, {
        bookingId: `TXS_ECO_${Date.now()}`,
        amount: "₹792",
        pickupLocation: "Dada Dev Mandir, Block H, Block B, Raj Nagar II Extension, Raj Nagar, Delhi, In...",
        dropLocation: "Geeta Colony, Delhi, India",
        distance: "27.5 km",
        duration: "55 min",
        rideType: "SUV",
        toPickupDistance: "0.5 km",
        toPickupTime: "4 min",
        tripDistance: "27.5 km",
        tripTime: "55 min",
        paymentType: "CASH",
        passengerName: "Deepak Sharma",
        passengerPhone: "+91 77777 66666",
        passengerRating: "4.5"
      });
      testsPassed++;
      logTest(6, "Economy Booking Request (Stacking)", 'success');
    } catch (error) {
      testsFailed++;
      logTest(6, "Economy Booking Request (Stacking)", 'error', error);
    }
    await delay(3000);

    // Test 7: Call while booking cards are active (Triple stack test)
    logTest(7, "Call During Active Bookings (Triple Stack)", 'start');
    try {
      await sendTaxiSureCallNotification(
        fcmToken,
        "Neha Gupta",
        "+91 88888 77777",
        {
          callType: "audio",
          userType: "customer",
          bookingId: "TXS009876",
          callerImage: "https://images.unsplash.com/photo-1494790108755-2616b612b31c?w=150&h=150&fit=crop&crop=face",
          callReason: "location_clarification",
          priority: "high",
          additionalData: {
            urgency: "high",
            currentLocation: "Near pickup point"
          }
        }
      );
      testsPassed++;
      logTest(7, "Call During Active Bookings (Triple Stack)", 'success');
    } catch (error) {
      testsFailed++;
      logTest(7, "Call During Active Bookings (Triple Stack)", 'error', error);
    }
    await delay(10000); // Wait to see all cards stacked

    // Test 8: Regular booking confirmation (Should show in notification bar)
    logTest(8, "Booking Confirmation Notification", 'start');
    try {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "Booking Confirmed ✅",
        "Your ride to IGI Airport Terminal 3 is confirmed. Driver will arrive in 5 minutes.",
        "booking_confirmed",
        {
          bookingId: "TXS112233",
          driverName: "Vikash Kumar",
          vehicleNumber: "DL 02 EF 9012",
          vehicleModel: "Swift Dzire",
          driverPhone: "+91 99887 76543",
          driverRating: "4.7",
          estimatedArrival: "5 minutes",
          destination: "IGI Airport Terminal 3"
        }
      );
      testsPassed++;
      logTest(8, "Booking Confirmation Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(8, "Booking Confirmation Notification", 'error', error);
    }
    await delay(2000);

    // Test 9: Payment success notification (Should show in notification bar)
    logTest(9, "Payment Success Notification", 'start');
    try {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "Payment Successful 💰",
        "₹650 paid successfully via UPI to Vikash Kumar",
        "payment_success",
        {
          transactionId: `TXN_${Date.now()}`,
          amount: "650",
          paymentMethod: "UPI",
          bookingId: "TXS445566",
          rideDate: new Date().toDateString(),
          from: "Home",
          to: "IGI Airport Terminal 3",
          driverName: "Vikash Kumar"
        }
      );
      testsPassed++;
      logTest(9, "Payment Success Notification", 'success');
    } catch (error) {
      testsFailed++;
      logTest(9, "Payment Success Notification", 'error', error);
    }
    await delay(2000);

    // Test 10: Ride status update (Should show in notification bar)
    logTest(10, "Ride Status Update", 'start');
    try {
      await sendTaxiSureRegularNotification(
        fcmToken,
        "Ride Started 🚗",
        "Your journey to Shimla has begun. Estimated time: 6 hours 30 minutes.",
        "ride_started",
        {
          bookingId: "TXS778899",
          destination: "Shimla, Himachal Pradesh",
          estimatedTime: "6 hours 30 minutes",
          estimatedDistance: "350 km",
          driverName: "Ramesh Sharma",
          vehicleNumber: "HP 01 CD 5678",
          currentLocation: "Delhi"
        }
      );
      testsPassed++;
      logTest(10, "Ride Status Update", 'success');
    } catch (error) {
      testsFailed++;
      logTest(10, "Ride Status Update", 'error', error);
    }
    await delay(2000);

    // Test 11: Emergency call (Should show as overlay card with high priority)
    logTest(11, "Emergency Call", 'start');
    try {
      await sendTaxiSureCallNotification(
        fcmToken,
        "TaxiSure Emergency Support",
        "+91 70000 12345",
        {
          callType: "audio",
          userType: "emergency",
          priority: "urgent",
          callerImage: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150&h=150&fit=crop&crop=face",
          callReason: "emergency_support",
          additionalData: {
            emergencyType: "safety_alert",
            supportAgentName: "Amit Singh",
            emergencyCode: "EMG2024001"
          }
        }
      );
      testsPassed++;
      logTest(11, "Emergency Call", 'success');
    } catch (error) {
      testsFailed++;
      logTest(11, "Emergency Call", 'error', error);
    }
    await delay(8000);

    // Test 12: Multiple rapid calls (Stress test for stacking)
    logTest(12, "Multiple Rapid Calls (Stress Test)", 'start');
    try {
      const rapidCalls = [
        { name: "Quick Test A", phone: "+91 11111 11111", type: "audio" as const, user: "customer" as const },
        { name: "Quick Test B", phone: "+91 22222 22222", type: "video" as const, user: "driver" as const },
        { name: "Quick Test C", phone: "+91 33333 33333", type: "audio" as const, user: "support" as const }
      ];

      for (let i = 0; i < rapidCalls.length; i++) {
        const call = rapidCalls[i];
        console.log(`📞 Sending rapid call ${i + 1}: ${call.name}...`);
        await sendTaxiSureCallNotification(
          fcmToken,
          call.name,
          call.phone,
          {
            callType: call.type,
            userType: call.user,
            callReason: "rapid_test",
            additionalData: {
              testIndex: i.toString(),
              testType: "rapid_fire"
            }
          }
        );
        await delay(1000); // Short delay between rapid calls
      }
      
      testsPassed++;
      logTest(12, "Multiple Rapid Calls (Stress Test)", 'success');
    } catch (error) {
      testsFailed++;
      logTest(12, "Multiple Rapid Calls (Stress Test)", 'error', error);
    }
    await delay(15000); // Wait to see all rapid calls

    // Test 13: Timer Progress Test (Special booking to test progress bars)
    logTest(13, "Timer Progress Test (15-Second Countdown)", 'start');
    try {
      await sendTaxiSureBookingNotification(fcmToken, {
        bookingId: `TIMER_TEST_${Date.now()}`,
        amount: "₹300",
        pickupLocation: "Timer Test Pickup Location",
        dropLocation: "Timer Test Destination",
        distance: "2.0 km",
        duration: "8 min",
        rideType: "AUTO",
        toPickupDistance: "0.3 km",
        toPickupTime: "2 min",
        tripDistance: "2.0 km",
        tripTime: "8 min",
        paymentType: "CASH",
        passengerName: "Timer Tester",
        passengerPhone: "+91 99999 99999"
      });
      testsPassed++;
      logTest(13, "Timer Progress Test (15-Second Countdown)", 'success');
      console.log("⏱️  Watch for: 15s countdown, circular + linear progress bars, auto-removal");
    } catch (error) {
      testsFailed++;
      logTest(13, "Timer Progress Test (15-Second Countdown)", 'error', error);
    }
    await delay(8000);

    // Test Summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 ALL TESTS COMPLETED!");
    console.log("=".repeat(60));
    console.log(`\n📊 Test Results:`);
    console.log(`✅ Tests Passed: ${testsPassed}`);
    console.log(`❌ Tests Failed: ${testsFailed}`);
    console.log(`📈 Success Rate: ${testsFailed === 0 ? '100%' : `${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`}`);
    
    console.log("\n📱 Expected App Behavior:");
    console.log("🔔 Regular notifications (5 tests) → Should appear in notification bar");
    console.log("📞 Call notifications (5 tests) → Should show as overlay cards with timer + progress");  
    console.log("🚖 Booking requests (3 tests) → Should show as overlay cards with timer + progress");
    console.log("📚 Multiple notifications → Should stack properly without overlap");
    console.log("⏱️  Timer behavior → 15s countdown with circular + linear progress bars");
    console.log("🎨 Progress indicators → Orange (turns red at ≤5s), auto-removal at 0s");
    
    console.log("\n🔍 Enhanced Verification Checklist:");
    console.log("□ No overlapping cards - proper vertical stacking");
    console.log("□ Dual progress bars (circular + linear) working on top cards only");  
    console.log("□ Proper card types (call vs booking vs regular)");
    console.log("□ Smooth slide-in animations from top");
    console.log("□ Strong haptic feedback on card appearance");
    console.log("□ Timer shows first (15s countdown), cross appears when timer ends");
    console.log("□ Auto-removal after 15 seconds");
    console.log("□ Scrollable card list for multiple cards");
    console.log("□ Color-coded progress (orange → red at 5 seconds)");
    console.log("□ Regular notifications in system notification bar only");

  } catch (error) {
    console.error("\n💥 Test suite failed:", error);
    console.error("❌ Error details:", error instanceof Error ? error.message : JSON.stringify(error, null, 2));
  }
}

// Enhanced helper function to test specific scenarios using corrected functions
async function testSpecificScenario(scenarioName: string) {
  console.log(`\n🎯 Testing specific scenario: ${scenarioName.toUpperCase()}`);
  console.log("-".repeat(50));
  
  if (!validateFcmToken(fcmToken)) {
    console.error("❌ Invalid FCM token. Please update your token.");
    return;
  }
  
  switch (scenarioName.toLowerCase()) {
    case "booking_only":
      console.log("📋 Scenario: Testing booking cards only (should show overlay with progress bars)");
      await sendTestBookingNotification(fcmToken);
      console.log("✅ Booking test completed");
      break;
      
    case "call_only":
      console.log("📋 Scenario: Testing call cards only (should show overlay with progress bars)");
      await sendTestCallNotification(fcmToken);
      console.log("✅ Call test completed");
      break;
      
    case "regular_only":
      console.log("📋 Scenario: Testing regular notifications only (should show in notification bar)");
      await sendTestRegularNotification(fcmToken);
      console.log("✅ Regular notification test completed");
      break;

    case "progress_test":
      console.log("📋 Scenario: Testing progress bars and timer functionality");
      await sendTaxiSureBookingNotification(fcmToken, {
        amount: "₹250",
        pickupLocation: "Progress Test Location", 
        dropLocation: "Progress Test Destination",
        rideType: "AUTO",
        passengerName: "Progress Tester"
      });
      console.log("✅ Progress test completed - watch for 15s countdown with dual progress bars");
      break;

    case "stacking_test":
      console.log("📋 Scenario: Testing multiple card stacking");
      for (let i = 1; i <= 3; i++) {
        await sendTaxiSureBookingNotification(fcmToken, {
          amount: `₹${i * 100}`,
          pickupLocation: `Stack Test Pickup ${i}`,
          dropLocation: `Stack Test Destination ${i}`,
          passengerName: `Stack Tester ${i}`
        });
        await delay(1000);
      }
      console.log("✅ Stacking test completed - check for 3 properly stacked cards");
      break;

    case "mixed_test":
      console.log("📋 Scenario: Testing mixed notification types");
      await sendTestRegularNotification(fcmToken);
      await delay(2000);
      await sendTestBookingNotification(fcmToken);
      await delay(2000);
      await sendTestCallNotification(fcmToken);
      console.log("✅ Mixed test completed - check for proper type distinction");
      break;
      
    default:
      console.log(`❌ Unknown scenario: ${scenarioName}`);
      console.log("Available scenarios:");
      console.log("  • booking_only    - Test booking cards with progress bars");
      console.log("  • call_only       - Test call cards with progress bars");
      console.log("  • regular_only    - Test regular notifications");
      console.log("  • progress_test   - Test timer and progress bar functionality");
      console.log("  • stacking_test   - Test multiple card stacking");
      console.log("  • mixed_test      - Test all types together");
  }
}

// Quick test function using the corrected functions
async function quickTest() {
  console.log("⚡ Running Quick Test Suite with Enhanced Functions...");
  console.log("-".repeat(50));
  
  if (!validateFcmToken(fcmToken)) {
    console.error("❌ Invalid FCM token. Please update your token.");
    return;
  }
  
  try {
    console.log("📨 1. Testing regular notification (should show in notification bar)...");
    await sendTestRegularNotification(fcmToken);
    await delay(2000);
    
    console.log("🚖 2. Testing booking card (should show overlay with progress bars)...");
    await sendTestBookingNotification(fcmToken);
    await delay(2000);
    
    console.log("📞 3. Testing call card (should show overlay with progress bars)...");
    await sendTestCallNotification(fcmToken);
    
    console.log("✅ Quick test completed! Check your app for:");
    console.log("   • Regular notification in notification bar");
    console.log("   • Booking card overlay with 15s timer + progress bars");
    console.log("   • Call card overlay with 15s timer + progress bars");
  } catch (error) {
    console.error("❌ Quick test failed:", error);
  }
}

// Export functions for modular testing
export {
  runComprehensiveTests,
  testSpecificScenario,
  quickTest,
  delay,
  logTest
};

// Run comprehensive tests if this file is executed directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case "quick":
    case "q":
      console.log("🔥 Starting Quick Test with Enhanced Functions...");
      quickTest().then(() => {
        console.log("\n🏁 Quick test execution completed!");
      }).catch(error => {
        console.error("\n💥 Quick test execution failed:", error);
        process.exit(1);
      });
      break;
      
    case "scenario":
    case "s":
      const scenarioName = args[1];
      if (!scenarioName) {
        console.error("❌ Please provide a scenario name");
        console.log("Available: booking_only, call_only, regular_only, progress_test, stacking_test, mixed_test");
        process.exit(1);
      }
      testSpecificScenario(scenarioName).then(() => {
        console.log(`\n🏁 Scenario test '${scenarioName}' completed!`);
      }).catch(error => {
        console.error(`\n💥 Scenario test failed:`, error);
        process.exit(1);
      });
      break;
      
    default:
      console.log("🔥 Starting Comprehensive FCM Test Suite with Enhanced Functions...");
      runComprehensiveTests().then(() => {
        console.log("\n🏁 Test suite execution completed!");
        console.log("📊 Check your app for all notification behaviors");
        console.log("⏱️  Focus on: Timer countdown, dual progress bars, proper card stacking");
      }).catch(error => {
        console.error("\n💥 Test suite execution failed:", error);
        process.exit(1);
      });
  }
}