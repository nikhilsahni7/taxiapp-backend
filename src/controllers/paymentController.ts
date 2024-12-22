import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

import Razorpay from "razorpay";
import {
  PrismaClient,
  RideStatus,
  TransactionStatus,
  TransactionType,
  PaymentMode,
} from "@prisma/client";
import { io } from "../server";
const prisma = new PrismaClient();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export const initiatePayment = async (req: Request, res: Response) => {
  const { rideId, amount, paymentMode } = req.body;

  if (paymentMode === "RAZORPAY") {
    try {
      const order = await razorpay.orders.create({
        amount: Math.round(amount * 100), // Amount in paise
        currency: "INR",
        receipt: uuidv4(),
      });

      await prisma.ride.update({
        where: { id: rideId },
        data: {
          razorpayOrderId: order.id,
          paymentMode: PaymentMode.RAZORPAY,
          paymentStatus: TransactionStatus.PENDING,
        },
      });

      return res.status(200).json({ order });
    } catch (error) {
      console.error("Error initiating Razorpay payment:", error);
      return res.status(500).json({ error: "Failed to initiate payment" });
    }
  }

  res.status(400).json({ error: "Invalid payment mode" });
};

export const verifyPayment = async (req: Request, res: Response) => {
  const { rideId, paymentId, orderId, signature } = req.body;

  // Razorpay signature verification can be added here

  try {
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" });
    }

    await prisma.transaction.create({
      data: {
        amount: ride.fare || 0,
        type: TransactionType.RIDE_PAYMENT,
        status: TransactionStatus.COMPLETED,
        receiverId: ride.driverId!,
        rideId: ride.id,
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        description: "Payment for ride completion",
      },
    });

    await prisma.wallet.update({
      where: { userId: ride.driverId! },
      data: { balance: { increment: ride.fare || 0 } },
    });

    await prisma.ride.update({
      where: { id: rideId },
      data: { paymentStatus: TransactionStatus.COMPLETED },
    });

    const driverWallet = await prisma.wallet.findUnique({
      where: { userId: ride.driverId! },
    });
    io.emit(`wallet_update_${ride.driverId}`, {
      balance: driverWallet?.balance,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Payment verification failed" });
  }
};

export const completeRide = async (req: Request, res: Response) => {
  const { rideId, paymentMode } = req.body;

  try {
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });

    if (!ride) {
      return res.status(404).json({ error: "Ride not found" });
    }

    if (paymentMode === "CASH") {
      await prisma.ride.update({
        where: { id: rideId },
        data: {
          paymentStatus: TransactionStatus.COMPLETED,
          status: RideStatus.RIDE_ENDED,
        },
      });

      io.to(ride.userId).emit("ride_status_update", {
        rideId,
        status: RideStatus.RIDE_ENDED,
      });
      io.to(ride.driverId || "").emit("ride_status_update", {
        rideId,
        status: RideStatus.RIDE_ENDED,
      });

      return res
        .status(200)
        .json({ success: true, message: "Ride completed with cash payment." });
    }

    res.status(400).json({ error: "Invalid payment mode for completion" });
  } catch (error) {
    console.error("Error completing ride:", error);
    res.status(500).json({ error: "Failed to complete ride" });
  }
};
