import {
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import type { Request, Response } from "express";
import Razorpay from "razorpay";

const prisma = new PrismaClient();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

// Vendor initiates wallet top-up
export const initiateVendorTopUp = async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;
    const vendorId = (req as any).user?.userId;

    const order = await razorpay.orders.create({
      amount: amount * 100, // Convert to paise
      currency: "INR",
      receipt: `vendor_topup_${Date.now()}`,
    });

    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WALLET_TOPUP,
        status: TransactionStatus.PENDING,
        senderId: vendorId,
        razorpayOrderId: order.id,
        description: "Vendor wallet top-up",
      },
    });

    res.json({
      orderId: order.id,
      amount,
      transactionId: transaction.id,
    });
  } catch (error) {
    console.error("Vendor top-up error:", error);
    res.status(500).json({ error: "Failed to initiate vendor top-up" });
  }
};

// Vendor requests withdrawal
export const requestVendorWithdrawal = async (req: Request, res: Response) => {
  try {
    const { amount, bankDetails } = req.body;
    const vendorId = (req as any).user?.userId;

    // Check wallet balance
    const wallet = await prisma.wallet.findUnique({
      where: { userId: vendorId },
    });

    if (!wallet || wallet.balance < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const transaction = await prisma.transaction.create({
      data: {
        amount,
        type: TransactionType.WITHDRAWAL,
        status: TransactionStatus.PENDING,
        senderId: vendorId,
        description: "Vendor withdrawal request",
        metadata: { bankDetails },
      },
    });

    res.json({
      success: true,
      transactionId: transaction.id,
      status: "PENDING",
    });
  } catch (error) {
    console.error("Vendor withdrawal error:", error);
    res
      .status(500)
      .json({ error: "Failed to process vendor withdrawal request" });
  }
};
