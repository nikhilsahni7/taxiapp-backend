import {
  PrismaClient,
  TransactionStatus,
  TransactionType,
} from "@prisma/client";
import crypto from "crypto";
import type { Request, Response } from "express";
import Razorpay from "razorpay";

const prisma = new PrismaClient();

interface AuthRequest extends Request {
  user?: {
    userId: string;
    userType: string;
    selfieUrl: string;
  };
}

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_SECRET!,
});

// Registration fee constants
const REGISTRATION_FEES: Record<string, number> = {
  mini: 1260,
  sedan: 1260,
  suv: 1260,
  ertiga: 1260,
  innova: 1260,
  tempo_12: 2160,
  tempo_16: 2160,
  tempo_20: 2160,
  tempo_26: 2160,
};

export const createRegistrationOrder = async (
  req: AuthRequest,
  res: Response
) => {
  const { vehicleCategory } = req.body;
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    // Check if driver exists and hasn't paid registration fee
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!driverDetails) {
      return res.status(404).json({ error: "Driver details not found" });
    }

    if (driverDetails.registrationFeePaid) {
      return res.status(400).json({ error: "Registration fee already paid" });
    }

    const registrationFee = REGISTRATION_FEES[vehicleCategory];
    if (!registrationFee) {
      return res.status(400).json({ error: "Invalid vehicle category" });
    }

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: registrationFee * 100, // Convert to paise
      currency: "INR",
      receipt: `REG${userId.slice(-8)}`,
      notes: {
        userId,
        type: "driver_registration_fee",
        vehicleCategory,
      },
    });

    res.json({
      success: true,
      order,
      amount: registrationFee,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Error creating registration fee order:", error);
    res.status(500).json({
      error: "Failed to create registration fee order",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const verifyRegistrationPayment = async (
  req: AuthRequest,
  res: Response
) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } =
    req.body;

  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    // Verify payment signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET!)
      .update(body.toString())
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Update driver details and create transaction record
    const result = await prisma.$transaction(async (prisma) => {
      // Get payment details from Razorpay
      const payment = await razorpay.payments.fetch(razorpay_payment_id);
      const amount = Number(payment.amount) / 100; // Convert from paise to rupees

      // Update driver details
      const updatedDriver = await prisma.driverDetails.update({
        where: { userId },
        data: { registrationFeePaid: true },
      });

      // Create transaction record
      const transaction = await prisma.transaction.create({
        data: {
          amount,
          type: TransactionType.DRIVER_REGISTRATION_FEE,
          status: TransactionStatus.COMPLETED,
          senderId: userId,
          currency: "INR",
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          description: "Driver registration fee payment",
          metadata: {
            paymentType: "RAZORPAY",
            vehicleCategory: updatedDriver.vehicleCategory,
          },
        },
      });

      return { updatedDriver, transaction };
    });

    res.json({
      success: true,
      message: "Registration fee payment verified successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error verifying registration payment:", error);
    res.status(500).json({
      error: "Failed to verify registration payment",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const checkRegistrationStatus = async (
  req: AuthRequest,
  res: Response
) => {
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId },
      select: {
        registrationFeePaid: true,
        vehicleCategory: true,
      },
    });

    if (!driverDetails) {
      return res.status(404).json({ error: "Driver details not found" });
    }

    const registrationFee = driverDetails.vehicleCategory
      ? REGISTRATION_FEES[driverDetails.vehicleCategory]
      : null;

    res.json({
      registrationFeePaid: driverDetails.registrationFeePaid,
      requiredFee: registrationFee,
      vehicleCategory: driverDetails.vehicleCategory,
    });
  } catch (error) {
    console.error("Error checking registration status:", error);
    res.status(500).json({
      error: "Failed to check registration status",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

// Middleware to check registration fee payment
export const checkRegistrationFee = async (
  userId: string
): Promise<boolean> => {
  try {
    const driverDetails = await prisma.driverDetails.findUnique({
      where: { userId },
      select: { registrationFeePaid: true },
    });

    return driverDetails?.registrationFeePaid ?? false;
  } catch (error) {
    console.error("Error checking registration fee:", error);
    return false;
  }
};
