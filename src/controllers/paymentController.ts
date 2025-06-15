// paymentController.ts
import {
    PaymentMode,
    PrismaClient,
    RideStatus,
    TransactionStatus,
    TransactionType,
} from "@prisma/client";
import type { Request, Response } from "express";
import Razorpay from "razorpay";
import { io } from "../server";
const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

// Commission Configuration - Easy to modify
const COMPANY_COMMISSION_RATE = 0.10; // 10% commission rate

import {
    sendTaxiSureRegularNotification,
    validateFcmToken,
} from "../utils/sendFcmNotification";

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_SECRET) {
  console.error("Razorpay credentials are not configured properly");
}

/**
 * Helper function to ensure driver wallet exists
 */
async function ensureDriverWallet(driverId: string): Promise<void> {
  try {
    console.log(`[Wallet] Checking/creating wallet for driver ${driverId}`);
    await prisma.wallet.upsert({
      where: { userId: driverId },
      update: {}, // Don't update if exists
      create: {
        userId: driverId,
        balance: 0,
        currency: "INR",
      },
    });
    console.log(`[Wallet] Driver wallet ensured for ${driverId}`);
  } catch (error) {
    console.error(
      `[Wallet] Failed to ensure driver wallet for ${driverId}:`,
      error
    );
    throw error;
  }
}

/**
 * Helper function to send notification to a specific user
 */
async function sendNotificationToUser(
  userId: string,
  title: string,
  body: string,
  notificationType:
    | "general"
    | "booking_confirmed"
    | "driver_arrived"
    | "ride_started"
    | "payment_success"
    | "promotion"
    | "rating_request",
  additionalData?: Record<string, string>
): Promise<void> {
  try {
    console.log(
      `[FCM-Payment] 📤 Attempting to send notification to user ${userId}: ${title}`
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true, name: true, userType: true },
    });

    console.log(
      `[FCM-Payment] 🔍 User found: ${user?.name || "Unknown"} (${user?.userType}), Has FCM token: ${!!user?.fcmToken}`
    );

    if (!user?.fcmToken) {
      console.warn(`[FCM-Payment] ❌ No FCM token found for user ${userId}`);
      return;
    }

    if (!validateFcmToken(user.fcmToken)) {
      console.warn(`[FCM-Payment] ❌ Invalid FCM token for user ${userId}`);
      return;
    }

    console.log(
      `[FCM-Payment] 📤 Sending payment notification via FCM to ${user.name}...`
    );
    await sendTaxiSureRegularNotification(
      user.fcmToken,
      title,
      body,
      notificationType,
      additionalData
    );

    console.log(
      `[FCM-Payment] ✅ Payment notification sent successfully to user ${user.name || userId}: ${title}`
    );
  } catch (error) {
    console.error(
      `[FCM-Payment] ❌ Failed to send notification to user ${userId}:`,
      error
    );
  }
}

// Handle ride completion and payment initiation
export const handleRideEnd = async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const { finalLocation } = req.body;

  try {
    // First check if ride exists and is in valid state
    const ride = await prisma.ride.findFirst({
      where: {
        id: rideId,
        status: RideStatus.RIDE_STARTED, // Only allow completion of started rides
      },
      include: {
        user: true,
        driver: true,
      },
    });

    if (!ride) {
      return res.status(404).json({
        error: "Ride not found or invalid status",
        details: "Ride must be in RIDE_STARTED status to end it",
      });
    }

    // Calculate final amount including any extra charges
    const finalAmount = calculateFinalAmount(ride);

    // Update ride with final details
    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: {
        dropLocation: finalLocation || ride.dropLocation,
        totalAmount: finalAmount,
        status:
          ride.paymentMode === PaymentMode.CASH
            ? RideStatus.RIDE_ENDED
            : RideStatus.PAYMENT_PENDING,
        paymentStatus:
          ride.paymentMode === PaymentMode.CASH
            ? TransactionStatus.COMPLETED
            : TransactionStatus.PENDING,
      },
      include: {
        user: true,
        driver: true,
      },
    });

    // Create fare breakdown for detailed billing
    const fareBreakdown = {
      baseFare: ride.fare || 0,
      waitingCharges: ride.waitingCharges || 0,
      carrierCharge: ride.carrierRequested ? ride.carrierCharge || 0 : 0,
      extraCharges: ride.extraCharges || 0,
      totalAmount: finalAmount,
    };

    // Emit ride completion event to both user and driver with fare breakdown
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      finalLocation,
      amount: finalAmount,
      paymentMode: ride.paymentMode,
      fareBreakdown: fareBreakdown,
    });

    if (ride.driverId) {
      io.to(ride.driverId).emit("ride_completed", {
        rideId: ride.id,
        finalLocation,
        amount: finalAmount,
        paymentMode: ride.paymentMode,
        fareBreakdown: fareBreakdown,
      });
    }

    // Handle based on payment mode
    if (ride.paymentMode === PaymentMode.CASH) {
      await handleCashPayment(updatedRide);

      // Emit payment status for cash rides
      io.to(ride.userId).emit("payment_status", {
        rideId: ride.id,
        status: "COMPLETED",
        amount: finalAmount,
      });

      if (ride.driverId) {
        io.to(ride.driverId).emit("payment_status", {
          rideId: ride.id,
          status: "COMPLETED",
          amount: finalAmount,
        });
      }

      return res.json({
        success: true,
        message: "Ride completed successfully",
        ride: updatedRide,
      });
    } else {
      const paymentDetails = await initiateRazorpayPayment(updatedRide);

      // Emit payment initiation for online payments
      io.to(ride.userId).emit("payment_status", {
        rideId: ride.id,
        status: "PENDING",
        amount: finalAmount,
        paymentDetails,
      });

      if (ride.driverId) {
        io.to(ride.driverId).emit("payment_status", {
          rideId: ride.id,
          status: "PENDING",
          amount: finalAmount,
          paymentDetails,
        });
      }

      return res.json({
        success: true,
        message: "Payment initiated",
        ride: updatedRide,
        paymentDetails,
      });
    }
  } catch (error) {
    console.error("Error completing ride:", error);
    return res.status(500).json({
      error: "Failed to complete ride",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Handle cash payment with commission and outstanding fee collection
export const handleCashPayment = async (ride: any) => {
  if (!ride.driverId) {
    throw new Error("Driver ID is required for cash payment processing");
  }

  const totalAmount = ride.totalAmount;

  // Check if an outstanding fee was applied (from metadata)
  const metadata = ride.metadata as any;
  const appliedLocalOutstandingFee = (metadata?.appliedLocalOutstandingFee as number) || 0;

  // Calculate commission only on base amount (excluding outstanding fee)
  const baseRideAmount = metadata?.baseRideAmount || (totalAmount - appliedLocalOutstandingFee);
  const commissionAmount = Math.round(baseRideAmount * COMPANY_COMMISSION_RATE);

  console.log(`[Cash Payment] Processing: Total=${totalAmount}, Base=${baseRideAmount}, Outstanding Fee=${appliedLocalOutstandingFee}, Commission=${commissionAmount}`);

  try {
    await ensureDriverWallet(ride.driverId);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create ride payment transaction (cash goes directly to driver)
      const rideTransaction = await tx.transaction.create({
        data: {
          amount: totalAmount,
          type: TransactionType.RIDE_PAYMENT,
          status: TransactionStatus.COMPLETED,
          senderId: ride.userId,
          receiverId: ride.driverId,
          rideId: ride.id,
          description: `Cash payment for ride ${ride.id} (direct to driver)`,
        },
      });

      // 2. Calculate total deductions from driver wallet
      const totalDeduction = commissionAmount + appliedLocalOutstandingFee;
      const finalWallet = await tx.wallet.update({
        where: { userId: ride.driverId },
        data: { balance: { decrement: totalDeduction } },
      });

      // 3. Create commission transaction record
      await tx.transaction.create({
        data: {
          amount: commissionAmount,
          type: TransactionType.COMPANY_COMMISSION,
          status: TransactionStatus.COMPLETED,
          senderId: ride.driverId,
          receiverId: null, // Company receives commission
          rideId: ride.id,
          description: `Company commission (${COMPANY_COMMISSION_RATE * 100}%) deducted for cash ride ${ride.id}`,
        },
      });

      // 4. Create outstanding fee collection transaction record (if applicable)
      if (appliedLocalOutstandingFee > 0) {
        await tx.transaction.create({
          data: {
            amount: appliedLocalOutstandingFee,
            type: TransactionType.USER_CANCELLATION_FEE_APPLIED,
            status: TransactionStatus.COMPLETED,
            senderId: ride.driverId,
            receiverId: null, // Company receives the fee
            rideId: ride.id,
            description: `Local outstanding fee (₹${appliedLocalOutstandingFee}) collected and deducted for cash ride ${ride.id}`,
          },
        });

        // 5. Reset user's localOutstandingFee
        await tx.user.update({
          where: { id: ride.userId },
          data: { localOutstandingFee: 0 },
        });
        console.log(`[Cash Payment] User ${ride.userId} localOutstandingFee reset to 0`);
      }

      // 6. Update driver's insufficient balance flag if needed
      await tx.driverDetails.update({
        where: { userId: ride.driverId },
        data: { hasInsufficientBalance: finalWallet.balance < 0 },
      });

      console.log(`[Cash Payment] Driver ${ride.driverId} wallet deductions: -₹${commissionAmount} (commission) -₹${appliedLocalOutstandingFee} (outstanding fee) = -₹${totalDeduction} total. Final balance: ₹${finalWallet.balance}`);
      return { rideTransaction, finalWallet };
    });

    // Send FCM notification
    setTimeout(async () => {
      try {
        await sendNotificationToUser(
          ride.userId,
          "🎉 Payment Completed - Trip Successful!",
          `Your ride payment of ₹${totalAmount} has been completed successfully via cash! ${appliedLocalOutstandingFee > 0 ? ' Outstanding fee cleared.' : ''} Thank you for choosing TaxiSure! ⭐ Please rate your experience!`,
          "payment_success",
          {
            rideId: ride.id,
            amount: totalAmount.toString(),
            paymentMethod: "cash",
            status: "completed",
            enableRating: "true",
            showReceiptOption: "true",
            tripSummary: "true",
            thankYouMessage: "true",
          }
        );
      } catch (fcmError) {
        console.error(`[FCM] Failed to send cash payment FCM notification:`, fcmError);
      }
    }, 1000);

    // Emit completion events
    const fareBreakdown = {
      baseFare: baseRideAmount,
      waitingCharges: ride.waitingCharges || 0,
      carrierCharge: ride.carrierRequested ? ride.carrierCharge || 0 : 0,
      extraCharges: ride.extraCharges || 0,
      outstandingFee: appliedLocalOutstandingFee,
      totalAmount: totalAmount,
      commissionDeducted: commissionAmount,
      outstandingFeeCollected: appliedLocalOutstandingFee,
      cashReceived: totalAmount, // Driver receives full cash amount
      walletDeduction: commissionAmount + appliedLocalOutstandingFee, // Total deducted from wallet
    };

    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      amount: totalAmount,
      status: "COMPLETED",
      distance: ride.distance || 0,
      duration: ride.duration || 0,
      fareBreakdown: fareBreakdown,
    });

    io.to(ride.driverId).emit("ride_completed", {
      rideId: ride.id,
      amount: totalAmount,
      status: "COMPLETED",
      fareBreakdown: fareBreakdown,
      walletBalance: result.finalWallet.balance,
    });

    return result.rideTransaction;
  } catch (error) {
    console.error(`[Cash Payment] Error processing ride ${ride.id}:`, error);
    throw error;
  }
};

// Initiate Razorpay payment
export const initiateRazorpayPayment = async (ride: any) => {
  try {
    const shortReceiptId = `r${Date.now().toString().slice(-8)}_${ride.id.slice(
      -4
    )}`;

    const order = await razorpay.orders.create({
      amount: Math.round(ride.totalAmount * 100), // Amount in paise
      currency: "INR",
      receipt: shortReceiptId,
      notes: {
        rideId: ride.id,
        userId: ride.userId,
        driverId: ride.driverId,
      },
    });

    // Create pending transaction
    await prisma.transaction.create({
      data: {
        amount: ride.totalAmount,
        type: TransactionType.RIDE_PAYMENT,
        status: TransactionStatus.PENDING,
        senderId: ride.userId,
        receiverId: ride.driverId,
        rideId: ride.id,
        razorpayOrderId: order.id,
        description: `Online payment for ride ${ride.id}`,
      },
    });

    // Update ride with order ID
    await prisma.ride.update({
      where: { id: ride.id },
      data: {
        razorpayOrderId: order.id,
      },
    });

    // Emit payment initiation event to user
    io.to(ride.userId).emit("initiate_payment", {
      rideId: ride.id,
      orderId: order.id,
      amount: ride.totalAmount,
      key: process.env.RAZORPAY_KEY_ID,
    });

    return {
      orderId: order.id,
      amount: ride.totalAmount,
    };
  } catch (error) {
    console.error("Error initiating Razorpay payment:", error);
    throw error;
  }
};

// Verify Razorpay payment
export const verifyPayment = async (req: Request, res: Response) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  try {
    // Verify payment signature
    const isValid = verifyPaymentSignature({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!isValid) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Find ride first and ensure driver wallet exists
    const ride = await prisma.ride.findFirst({
      where: { razorpayOrderId: razorpay_order_id },
      include: { user: true, driver: true },
    });

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" });
    }

    // Ensure driver wallet exists before processing payment
    if (ride.driverId) {
      await ensureDriverWallet(ride.driverId);
    }

    // Process payment in transaction with commission and outstanding fee handling
    const totalAmount = ride.totalAmount || 0;

    // Check if an outstanding fee was applied (from metadata)
    const metadata = ride.metadata as any;
    const appliedLocalOutstandingFee = (metadata?.appliedLocalOutstandingFee as number) || 0;

    // Calculate commission only on base amount (excluding outstanding fee)
    const baseRideAmount = metadata?.baseRideAmount || (totalAmount - appliedLocalOutstandingFee);
    const commissionAmount = Math.round(baseRideAmount * COMPANY_COMMISSION_RATE);
    const driverAmount = baseRideAmount - commissionAmount; // Driver gets 90% of base only

    console.log(`[Online Payment] Total=${totalAmount}, Base=${baseRideAmount}, Outstanding Fee=${appliedLocalOutstandingFee}, Commission=${commissionAmount}, Driver=${driverAmount}`);

    const result = await prisma.$transaction(async (tx) => {
      // Update ride status
      const updatedRide = await tx.ride.update({
        where: { id: ride.id },
        data: {
          status: RideStatus.RIDE_ENDED,
          paymentStatus: TransactionStatus.COMPLETED,
        },
        include: { user: true, driver: true },
      });

      // Update transaction
      const updatedTransaction = await tx.transaction.update({
        where: { razorpayOrderId: razorpay_order_id },
        data: {
          status: TransactionStatus.COMPLETED,
          razorpayPaymentId: razorpay_payment_id,
        },
      });

      // Add only 90% of base amount to driver's wallet (company keeps commission + outstanding fee)
      const updatedWallet = await tx.wallet.update({
        where: { userId: ride.driverId! },
        data: { balance: { increment: driverAmount } },
      });

      // Create commission transaction record
      await tx.transaction.create({
        data: {
          amount: commissionAmount,
          type: TransactionType.COMPANY_COMMISSION,
          status: TransactionStatus.COMPLETED,
          senderId: ride.userId,
          receiverId: null, // Company receives commission
          rideId: ride.id,
          description: `Company commission (${COMPANY_COMMISSION_RATE * 100}%) for online ride ${ride.id}`,
        },
      });

      // Reset user's localOutstandingFee if applicable
      if (appliedLocalOutstandingFee > 0) {
        await tx.user.update({
          where: { id: ride.userId },
          data: { localOutstandingFee: 0 },
        });
        console.log(`[Online Payment] User ${ride.userId} localOutstandingFee reset to 0`);
      }

      console.log(`[Online Payment] Driver ${ride.driverId} received ${driverAmount} (90% of base ${baseRideAmount}). Wallet balance: ${updatedWallet.balance}`);

      return {
        ride: updatedRide,
        transaction: updatedTransaction,
        wallet: updatedWallet,
      };
    });

    // Emit completion events
    io.to(result.ride.userId).emit("payment_completed", {
      rideId: result.ride.id,
      amount: totalAmount,
      paymentId: razorpay_payment_id,
    });

    io.to(result.ride.driverId!).emit("payment_completed", {
      rideId: result.ride.id,
      amount: totalAmount,
      paymentId: razorpay_payment_id,
      walletBalance: result.wallet.balance,
    });

    // Send FCM notifications for online payment completion - Fixed async call
    setTimeout(async () => {
      try {
        console.log(
          `[FCM] Sending online payment completion notification to user ${result.ride.userId}`
        );
        await sendNotificationToUser(
          result.ride.userId,
          "🎉 Payment Successful - Journey Complete!",
          `Your ride payment of ₹${totalAmount} has been processed successfully via online payment! ${appliedLocalOutstandingFee > 0 ? ' Outstanding fee cleared.' : ''} Thank you for choosing TaxiSure! ⭐ Please rate your experience!`,
          "payment_success",
          {
            rideId: result.ride.id,
            amount: totalAmount.toString(),
            paymentMethod: "online",
            razorpayPaymentId: razorpay_payment_id,
            status: "completed",
            enableRating: "true",
            showReceiptOption: "true",
            tripSummary: "true",
            thankYouMessage: "true",
            showLoyaltyPoints: "true",
          }
        );
        console.log(
          `[FCM] Online payment completion notification sent successfully to user ${result.ride.userId}`
        );
      } catch (fcmError) {
        console.error(
          `[FCM] Failed to send online payment completion FCM notification to user ${result.ride.userId}:`,
          fcmError
        );
      }
    }, 1000); // Delay by 1 second to ensure transaction is complete

    return res.json({
      success: true,
      ride: result.ride,
      transaction: result.transaction,
    });
  } catch (error) {
    console.error("Error in payment verifications:", error);
    return res.status(500).json({ error: "Failed to verify payment" });
  }
};

// Calculate final amount
export const calculateFinalAmount = (ride: any): number => {
  // Simply return the base fare
  const baseFare = ride.fare || 0;

  console.log(`[calculateFinalAmount] Using base fare: ${baseFare}`);
  return baseFare;
};

// Socket event handlers
export const setupPaymentSocketEvents = (socket: any) => {
  socket.on(
    "end_ride",
    async (data: { rideId: string; finalLocation: string }) => {
      try {
        const ride = await prisma.ride.findUnique({
          where: { id: data.rideId },
          include: { user: true, driver: true },
        });

        if (!ride) {
          socket.emit("error", { message: "Ride not found" });
          return;
        }

        // Calculate final amount
        const finalAmount = calculateFinalAmount(ride);

        // Update ride status
        const updatedRide = await prisma.ride.update({
          where: { id: data.rideId },
          data: {
            dropLocation: data.finalLocation,
            totalAmount: finalAmount,
            status:
              ride.paymentMode === PaymentMode.CASH
                ? RideStatus.RIDE_ENDED
                : RideStatus.PAYMENT_PENDING,
          },
        });

        // Create fare breakdown
        const fareBreakdown = {
          baseFare: ride.fare || 0,
          waitingCharges: ride.waitingCharges || 0,
          carrierCharge: ride.carrierRequested ? ride.carrierCharge || 0 : 0,
          extraCharges: ride.extraCharges || 0,
          totalAmount: finalAmount,
        };

        // Emit ride end event to user with detailed fare breakdown
        socket.to(ride.userId).emit("ride_ended", {
          rideId: ride.id,
          finalLocation: data.finalLocation,
          amount: finalAmount,
          paymentMode: ride.paymentMode,
          fareBreakdown: fareBreakdown,
        });

        // Handle payment based on mode
        if (ride.paymentMode === PaymentMode.CASH) {
          await handleCashPayment(updatedRide);
        } else {
          await initiateRazorpayPayment(updatedRide);
        }
      } catch (error) {
        console.error("Error in end_ride socket event:", error);
        socket.emit("error", { message: "Failed to end ride" });
      }
    }
  );

  socket.on(
    "payment_initiated",
    (data: { rideId: string; orderId: string }) => {
      socket.to(data.rideId).emit("payment_status", {
        status: "INITIATED",
        orderId: data.orderId,
      });
    }
  );

  socket.on("payment_failed", (data: { rideId: string; error: string }) => {
    socket.to(data.rideId).emit("payment_status", {
      status: "FAILED",
      error: data.error,
    });
  });
};

// Helper function to verify Razorpay signature
// Replace the existing verifyPaymentSignature function
const verifyPaymentSignature = (params: {
  order_id: string;
  payment_id: string;
  signature: string;
}): boolean => {
  try {
    const crypto = require("crypto");
    const hmac = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET!);
    hmac.update(params.order_id + "|" + params.payment_id);
    const generated_signature = hmac.digest("hex");
    return generated_signature === params.signature;
  } catch (error) {
    console.error("Error in signature verification:", error);
    return false;
  }
};
