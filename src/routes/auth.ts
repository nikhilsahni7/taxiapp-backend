import express from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import twilio from "twilio";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { verifyToken } from "../middlewares/auth";
import { uploadImage } from "../config/cloudinary";
import multer from "multer";

const router = express.Router();
const prisma = new PrismaClient();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const uploadFields = upload.fields([{ name: "selfiePath", maxCount: 1 }]);

// Send OTP
router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save OTP to database
    await prisma.oTP.create({
      data: {
        phone,
        code: otp,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    // Send OTP via Twilio
    await twilioClient.messages.create({
      body: `Your Verification code for TaxiSure is ${otp}`,
      from: process.env.TWILIO_PHONE_NUMBER!,
      to: phone,
    });

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to send OTP" });
  }
});
// Verify OTP and Sign Up
router.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp } = req.body;

    // Validate input
    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const validOTP = await prisma.oTP.findFirst({
      where: {
        phone,
        code: otp,
        verified: false,
        expiresAt: { gte: new Date() },
      },
    });

    if (!validOTP) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Mark OTP as verified
    await prisma.oTP.update({
      where: { id: validOTP.id },
      data: { verified: true },
    });

    // Create user with verified status
    const user = await prisma.user.create({
      data: {
        phone,
        userType: "USER",
        verified: true,
      },
    });

    const token = jwt.sign(
      { userId: user.id, userType: user.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      userId: user.id,
      message: "User verified and created successfully",
    });
  } catch (error: any) {
    console.error("Verify OTP error:", error);
    res.status(500).json({
      error: error.message || "Failed to verify OTP",
    });
  }
});

// Sign In (simplified to use phone number only)
router.post("/sign-in", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user || !user.verified) {
      return res
        .status(400)
        .json({ error: "Invalid phone number or user not verified" });
    }

    const token = jwt.sign(
      { userId: user.id, userType: user.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({ token, userId: user.id });
  } catch (error) {
    res.status(500).json({ error: "Failed to sign in" });
  }
});

// Register user detailsC
router.post("/register/:type", verifyToken, uploadFields, async (req, res) => {
  try {
    const { type } = req.params;

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!["DRIVER", "VENDOR", "USER"].includes(type.toUpperCase())) {
      return res.status(400).json({ error: "Invalid user type" });
    }

    const userId = req.user.userId;
    const { name, email, state, city } = req.body;

    // Log the received data for debugging
    console.log("Received fields:", req.body);
    console.log("Received files:", req.files);

    // Upload selfie from buffer
    let selfieUrl = null;
    if (
      req.files &&
      (req.files as { [fieldname: string]: Express.Multer.File[] })[
        "selfiePath"
      ]
    ) {
      const fileBuffer = (
        req.files as { [fieldname: string]: Express.Multer.File[] }
      )["selfiePath"][0].buffer;
      selfieUrl = await uploadImage(fileBuffer);
    }

    // Update user information
    await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        email,
        state,
        city,
        selfieUrl,
      },
    });

    // Handle type-specific details with image uploads
    const specificDetails = req.body.specificDetails || {};

    switch (type.toUpperCase()) {
      case "DRIVER":
        const dlUrl = await uploadImage(specificDetails.dlPath);
        specificDetails.dlUrl = dlUrl;
        await prisma.driverDetails.create({
          data: {
            userId,
            ...specificDetails,
          },
        });
        break;
      case "VENDOR":
        const aadharFrontUrl = await uploadImage(
          specificDetails.aadharFrontPath
        );
        const aadharBackUrl = await uploadImage(specificDetails.aadharBackPath);
        const panUrl = await uploadImage(specificDetails.panPath);
        specificDetails.aadharFrontUrl = aadharFrontUrl;
        specificDetails.aadharBackUrl = aadharBackUrl;
        specificDetails.panUrl = panUrl;
        await prisma.vendorDetails.create({
          data: {
            userId,
            ...specificDetails,
          },
        });
        break;
      default:
        await prisma.userDetails.create({
          data: { userId },
        });
    }

    res.json({ message: "Registration completed successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to complete registration" });
  }
});

// Admin registration (one-time setup)
router.post("/admin-register", async (req: Request, res: Response) => {
  try {
    const ADMIN_PHONE = "9999999999"; // Hardcoded admin phone

    // Check if admin already exists
    const existingAdmin = await prisma.user.findFirst({
      where: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
      },
    });

    if (existingAdmin) {
      return res.status(400).json({ error: "Admin already exists" });
    }

    // Create admin user
    const admin = await prisma.user.create({
      data: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
        verified: true,
        name: "Admin",
      },
    });

    const token = jwt.sign(
      { userId: admin.id, userType: admin.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Admin registered successfully",
      token,
      adminId: admin.id,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to register admin" });
  }
});

// Admin sign-in with hardcoded phone
router.post("/admin-sign-in", async (req: Request, res: Response) => {
  try {
    const ADMIN_PHONE = "9999999999"; // Same hardcoded phone

    const admin = await prisma.user.findFirst({
      where: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
      },
    });

    if (!admin) {
      return res.status(401).json({ error: "Admin not found" });
    }

    const token = jwt.sign(
      { userId: admin.id, userType: admin.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      adminId: admin.id,
      message: "Admin signed in successfully",
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to sign in" });
  }
});

// Driver sign-in (simplified)
router.post("/driver-sign-in", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const driver = await prisma.user.findFirst({
      where: {
        phone,
        userType: "DRIVER",
      },
      include: {
        driverDetails: true,
      },
    });

    if (!driver || !driver.verified) {
      return res
        .status(401)
        .json({ error: "Invalid phone number or driver not verified" });
    }

    const token = jwt.sign(
      {
        userId: driver.id,
        userType: driver.userType,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      driverId: driver.id,
      name: driver.name,
      phone: driver.phone,
      verified: driver.verified,
      vehicleDetails: driver.driverDetails,
    });
  } catch (error) {
    console.error("Driver sign-in error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Logout
router.post("/logout", verifyToken, (req, res) => {
  res.json({ message: "Logged out successfully" });
});

export { router as authRouter };
