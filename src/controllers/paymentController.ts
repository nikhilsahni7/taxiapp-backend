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

// # RAZORPAY_KEY_ID="rzp_live_hfAQTM2pl9qyV7"

// # RAZORPAY_SECRET="eCARS6to6Gmj5g3TRH5RtSNn"

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_SECRET) {
  console.error("Razorpay credentials are not configured properly");
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

    // Emit ride completion event to both user and driver
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      finalLocation,
      amount: finalAmount,
      paymentMode: ride.paymentMode,
    });

    if (ride.driverId) {
      io.to(ride.driverId).emit("ride_completed", {
        rideId: ride.id,
        finalLocation,
        amount: finalAmount,
        paymentMode: ride.paymentMode,
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

// Handle cash payment
export const handleCashPayment = async (ride: any) => {
  try {
    // Create transaction record
    const transaction = await prisma.transaction.create({
      data: {
        amount: ride.totalAmount,
        type: TransactionType.RIDE_PAYMENT,
        status: TransactionStatus.COMPLETED,
        senderId: ride.userId,
        receiverId: ride.driverId,
        rideId: ride.id,
        description: `Cash payment for ride ${ride.id}`,
      },
    });

    // Update driver's wallet
    await prisma.wallet.upsert({
      where: { userId: ride.driverId },
      update: {
        balance: {
          increment: ride.totalAmount,
        },
      },
      create: {
        userId: ride.driverId,
        balance: ride.totalAmount,
        currency: "INR",
      },
    });

    // Emit completion events
    io.to(ride.userId).emit("ride_completed", {
      rideId: ride.id,
      amount: ride.totalAmount,
      status: "COMPLETED",
    });

    io.to(ride.driverId).emit("ride_completed", {
      rideId: ride.id,
      amount: ride.totalAmount,
      status: "COMPLETED",
    });

    return transaction;
  } catch (error) {
    console.error("Error in cash payment:", error);
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

    // Process payment in transaction
    const result = await prisma.$transaction(async (prisma) => {
      // Find ride and transaction
      const ride = await prisma.ride.findFirst({
        where: { razorpayOrderId: razorpay_order_id },
        include: { user: true, driver: true },
      });

      if (!ride) {
        throw new Error("Ride not found");
      }

      // Update ride status
      const updatedRide = await prisma.ride.update({
        where: { id: ride.id },
        data: {
          status: RideStatus.RIDE_ENDED,
          paymentStatus: TransactionStatus.COMPLETED,
        },
        include: { user: true, driver: true },
      });

      // Update transaction
      const updatedTransaction = await prisma.transaction.update({
        where: { razorpayOrderId: razorpay_order_id },
        data: {
          status: TransactionStatus.COMPLETED,
          razorpayPaymentId: razorpay_payment_id,
        },
      });

      // Update driver's wallet
      const updatedWallet = await prisma.wallet.upsert({
        where: { userId: ride.driverId! },
        update: {
          balance: {
            increment: ride.totalAmount!,
          },
        },
        create: {
          userId: ride.driverId!,
          balance: ride.totalAmount!,
          currency: "INR",
        },
      });

      return {
        ride: updatedRide,
        transaction: updatedTransaction,
        wallet: updatedWallet,
      };
    });

    // Emit completion events
    io.to(result.ride.userId).emit("payment_completed", {
      rideId: result.ride.id,
      amount: result.ride.totalAmount,
      paymentId: razorpay_payment_id,
    });

    io.to(result.ride.driverId!).emit("payment_completed", {
      rideId: result.ride.id,
      amount: result.ride.totalAmount,
      paymentId: razorpay_payment_id,
      walletBalance: result.wallet.balance,
    });

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
  // If totalAmount is already set (e.g., from ride completion), use it
  if (ride.totalAmount) {
    return ride.totalAmount;
  }

  // Otherwise use fare which should already include waiting charges
  // from the calculateWaitingCharges function in rideController.ts
  return ride.fare || 0;
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

        // Emit ride end event to user
        socket.to(ride.userId).emit("ride_ended", {
          rideId: ride.id,
          finalLocation: data.finalLocation,
          amount: finalAmount,
          paymentMode: ride.paymentMode,
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
