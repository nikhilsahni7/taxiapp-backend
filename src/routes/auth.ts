import express from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

interface AuthRequest extends Request {
  user: {
    userId: string;
    userType: string;
  };
}
import twilio from "twilio";
import jwt from "jsonwebtoken";

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

const uploadFields = upload.fields([
  { name: "selfiePath", maxCount: 1 },
  { name: "dlPath", maxCount: 1 },
  { name: "permitImages", maxCount: 4 },
  { name: "carFront", maxCount: 1 },
  { name: "carBack", maxCount: 1 },
]);

// Send OTP
router.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;

    // Send OTP via Twilio Verify Service
    await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID!)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send OTP error:", error);
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

    // Verify OTP using Twilio Verify Service
    const verification = await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID!)
      .verificationChecks.create({
        to: phone,
        code: otp,
      });

    if (!verification.valid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

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

// Add this new route after the existing verify-otp route
router.post("/verify-driver-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp } = req.body;

    // Validate input
    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if driver already exists
    const existingDriver = await prisma.user.findUnique({
      where: {
        phone,
        userType: "DRIVER",
      },
    });

    if (existingDriver) {
      return res.status(400).json({ error: "Driver already exists" });
    }

    // Verify OTP using Twilio Verify Service
    const verification = await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID!)
      .verificationChecks.create({
        to: phone,
        code: otp,
      });

    if (!verification.valid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Create driver with verified status
    const driver = await prisma.user.create({
      data: {
        phone,
        userType: "DRIVER",
        verified: true,
      },
    });

    const token = jwt.sign(
      { userId: driver.id, userType: driver.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      userId: driver.id,
      message: "Driver verified and created successfully",
    });
  } catch (error: any) {
    console.error("Verify Driver OTP error:", error);
    res.status(500).json({
      error: error.message || "Failed to verify OTP",
    });
  }
});

// Verify OTP and create vendor
router.post("/verify-vendor-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp } = req.body;

    // Validate input
    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if vendor already exists
    const existingVendor = await prisma.user.findUnique({
      where: {
        phone,
        userType: "VENDOR",
      },
    });

    if (existingVendor) {
      return res.status(400).json({ error: "Vendor already exists" });
    }

    // Verify OTP using Twilio Verify Service
    const verification = await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID!)
      .verificationChecks.create({
        to: phone,
        code: otp,
      });

    if (!verification.valid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    // Create vendor with verified status
    const vendor = await prisma.user.create({
      data: {
        phone,
        userType: "VENDOR",
        verified: true,
      },
    });

    const token = jwt.sign(
      { userId: vendor.id, userType: vendor.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      userId: vendor.id,
      message: "Vendor verified and created successfully",
    });
  } catch (error: any) {
    console.error("Verify Vendor OTP error:", error);
    res.status(500).json({
      error: error.message || "Failed to verify OTP",
    });
  }
});

// Vendor registration endpoint
router.post(
  "/vendor-register",
  verifyToken,
  upload.fields([
    { name: "aadharFront", maxCount: 1 },
    { name: "aadharBack", maxCount: 1 },
    { name: "panCard", maxCount: 1 },
  ]),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user.userId;
      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined;

      const {
        businessName,
        address,
        experience,
        gstNumber,
        aadharNumber,
        panNumber,
      } = req.body;

      // Upload documents
      const aadharFrontUrl = files?.["aadharFront"]?.[0]
        ? await uploadImage(files["aadharFront"][0].buffer)
        : null;
      const aadharBackUrl = files?.["aadharBack"]?.[0]
        ? await uploadImage(files["aadharBack"][0].buffer)
        : null;
      const panUrl = files?.["panCard"]?.[0]
        ? await uploadImage(files["panCard"][0].buffer)
        : null;

      // Update user type to VENDOR
      await prisma.user.update({
        where: { id: userId },
        data: {
          userType: "VENDOR",
        },
      });

      // Create vendor details
      await prisma.vendorDetails.create({
        data: {
          userId,
          businessName,
          address,
          experience,
          gstNumber,
          aadharNumber,
          panNumber,
          aadharFrontUrl,
          aadharBackUrl,
          panUrl,
        },
      });

      // Generate new token with updated user type
      const token = jwt.sign(
        { userId, userType: "VENDOR" },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      const user = await prisma.user.findUnique({
        where: {
          id: userId,
          userType: "VENDOR",
        },
        include: { vendorDetails: true },
      });

      res.json({
        message: "Vendor registration completed successfully",
        token,
        userId,
        userType: "VENDOR",
        name: user?.name,
        phone: user?.phone,
        verified: user?.verified,
      });
    } catch (error) {
      console.error("Vendor registration error:", error);
      res.status(500).json({
        error: "Failed to complete vendor registration",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

// Vendor sign-in
router.post("/vendor-sign-in", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const vendor = await prisma.user.findFirst({
      where: {
        phone,
        userType: "VENDOR",
      },
      include: {
        vendorDetails: true,
      },
    });

    if (!vendor || !vendor.verified) {
      return res.status(401).json({
        error: "Invalid phone number or vendor not verified",
        vendor: vendor,
        vendorDetails: vendor?.vendorDetails,
      });
    }

    const token = jwt.sign(
      {
        userId: vendor.id,
        userType: vendor.userType,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      vendorId: vendor.id,
      name: vendor.name,
      phone: vendor.phone,
      verified: vendor.verified,
      vendorDetails: vendor.vendorDetails,
    });
  } catch (error) {
    console.error("Vendor sign-in error:", error);
    res.status(500).json({ error: "Internal server error" });
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

    res.json({
      token,
      userId: user.id,
      userType: user.userType,
      name: user.name,
      phone: user.phone,
      verified: user.verified,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to sign in" });
  }
});

router.post(
  "/register/:type",
  verifyToken,
  uploadFields,
  async (req: AuthRequest, res) => {
    try {
      const { type } = req.params;
      const userId = req.user.userId;
      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined;

      // Common fields for both user types
      const { name, email, state, city } = req.body;

      // Upload selfie for both user types
      const selfieUrl = files?.["selfiePath"]?.[0]
        ? await uploadImage(files["selfiePath"][0].buffer)
        : null;

      // Update base user information
      await prisma.user.update({
        where: { id: userId },
        data: {
          name,
          email,
          state,
          city,
          selfieUrl,
          userType: type.toUpperCase() as "USER" | "DRIVER" | "ADMIN",
        },
      });

      if (type.toUpperCase() === "DRIVER") {
        const {
          aadharNumber,
          panNumber,
          dlNumber,
          vehicleNumber,
          vehicleName,
          vehicleCategory,
        } = req.body;

        const dlUrl = files?.["dlPath"]?.[0]
          ? await uploadImage(files["dlPath"][0].buffer)
          : null;
        const carFrontUrl = files?.["carFront"]?.[0]
          ? await uploadImage(files["carFront"][0].buffer)
          : null;
        const carBackUrl = files?.["carBack"]?.[0]
          ? await uploadImage(files["carBack"][0].buffer)
          : null;

        // Handle permit images
        const permitUrls = files?.["permitImages"]
          ? await Promise.all(
              files["permitImages"].map((file) => uploadImage(file.buffer))
            )
          : [];

        // Create driver details
        await prisma.driverDetails.create({
          data: {
            userId,
            aadharNumber,
            panNumber,
            dlNumber,
            vehicleNumber,
            vehicleName,
            vehicleCategory,
            dlUrl,
            permitUrls,
            carFrontUrl,
            carBackUrl,
          },
        });
      } else if (type.toUpperCase() === "USER") {
        // Create user details
        await prisma.userDetails.create({
          data: {
            userId,
          },
        });
      } else {
        return res.status(400).json({ error: "Invalid user type" });
      }

      // Generate new token with updated user type
      const token = jwt.sign(
        { userId, userType: type.toUpperCase() },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      res.json({
        message: `${type} registration completed successfully`,
        token,
        userId: userId,
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({
        error: "Failed to complete registration",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

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
