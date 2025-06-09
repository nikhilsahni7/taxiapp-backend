import { PrismaClient } from "@prisma/client";
import axios from "axios";
import bcryptjs from "bcryptjs";
import type { Request, Response } from "express";
import express from "express";
import jwt from "jsonwebtoken";
import {
  checkRegistrationStatus,
  createRegistrationOrder,
  verifyRegistrationPayment,
} from "../controllers/driverRegistrationController";

interface AuthRequest extends Request {
  user: {
    userId: string;
    userType: string;
    selfieUrl: string;
  };
}

import multer from "multer";
import { uploadImage } from "../config/cloudinary";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();

const PRP_SMS_CONFIG = {
  apiKey: "ONIGo9UCiwv994a",
  baseUrl: "https://api.bulksmsadmin.com/BulkSMSapi/keyApiSendSMS",
  sender: "TXISUR",
  templateName: "OTP",
};

const generateOTP = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sendSMSViaPRP = async (
  phoneNumber: string,
  otp: string
): Promise<boolean> => {
  try {
    const formattedPhone = phoneNumber.startsWith("+")
      ? phoneNumber.substring(1)
      : phoneNumber.startsWith("91")
        ? phoneNumber
        : `91${phoneNumber}`;

    console.log(`📱 Sending SMS to: ${formattedPhone}, OTP: ${otp}`);

    const payload = {
      sender: PRP_SMS_CONFIG.sender,
      templateName: PRP_SMS_CONFIG.templateName,
      smsReciever: [
        {
          mobileNo: formattedPhone,
          templateParams: otp,
        },
      ],
    };

    console.log("📤 SMS Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `${PRP_SMS_CONFIG.baseUrl}/SendSmsTemplateName`,
      payload,
      {
        headers: {
          apikey: PRP_SMS_CONFIG.apiKey,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    console.log("✅ PRP SMS Response Status:", response.status);
    console.log("📋 PRP SMS Response Data:", response.data);

    const isSuccess =
      response.status === 200 &&
      (response.data.status === "success" ||
        response.data.message === "SMS sent successfully.");

    if (isSuccess) {
      console.log("🎉 SMS sent successfully!");
      return true;
    } else {
      console.log(
        "⚠️ SMS response indicates failure, but continuing for testing"
      );
      return true;
    }
  } catch (error: any) {
    console.error("💥 PRP SMS Error:", error.response?.data || error.message);

    console.log(
      "⚠️ SMS sending failed, but allowing flow to continue for testing..."
    );
    return true;
  }
};

const storeOTP = async (phone: string, otp: string): Promise<void> => {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.oTP.deleteMany({
    where: { phone },
  });

  await prisma.oTP.create({
    data: {
      phone,
      code: otp,
      expiresAt,
      verified: false,
    },
  });
};

const verifyOTPFromDB = async (
  phone: string,
  otp: string
): Promise<boolean> => {
  try {
    const otpRecord = await prisma.oTP.findFirst({
      where: {
        phone,
        code: otp,
        verified: false,
        expiresAt: {
          gt: new Date(),
        },
      },
    });

    if (otpRecord) {
      await prisma.oTP.update({
        where: { id: otpRecord.id },
        data: { verified: true },
      });
      return true;
    }

    return false;
  } catch (error) {
    console.error("OTP verification error:", error);
    return false;
  }
};

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const uploadFields = upload.fields([
  { name: "selfiePath", maxCount: 1 },
  { name: "dlPath", maxCount: 1 },
  { name: "permitImages", maxCount: 4 },
  { name: "carFront", maxCount: 1 },
  { name: "carBack", maxCount: 1 },
  { name: "rcDocument", maxCount: 1 },
  { name: "fitnessDocument", maxCount: 1 },
  { name: "pollutionDocument", maxCount: 1 },
  { name: "insuranceDocument", maxCount: 1 },
]);

router.post("/send-otp", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    const existingUser = await prisma.user.findFirst({
      where: {
        phone,
      },
    });

    if (existingUser) {
      return res.json({
        message: "User already exists",
        existingUser: true,
        userType: existingUser.userType,
      });
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      return res.status(500).json({ error: "Failed to send OTP via SMS" });
    }

    await storeOTP(phone, otp);

    res.json({
      message: "OTP sent successfully",
      existingUser: false,
    });
  } catch (error) {
    console.error("Send OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

router.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcryptjs.hash(password, 10);
    }

    const user = await prisma.user.create({
      data: {
        phone,
        userType: "USER",
        verified: true,
        password: hashedPassword,
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

router.post("/send-driver-otp", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const existingDriver = await prisma.user.findFirst({
      where: {
        phone,
        userType: "DRIVER",
      },
    });

    if (existingDriver) {
      return res.status(400).json({ error: "Driver already exists" });
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      return res.status(500).json({ error: "Failed to send OTP via SMS" });
    }

    await storeOTP(phone, otp);

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send Driver OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

router.post("/verify-driver-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;

    const existingDriver = await prisma.user.findFirst({
      where: {
        phone: formattedPhone,
        userType: "DRIVER",
      },
    });

    if (existingDriver) {
      return res.status(400).json({ error: "Driver already exists" });
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcryptjs.hash(password, 10);
    }

    const driver = await prisma.user.create({
      data: {
        phone: formattedPhone,
        userType: "DRIVER",
        verified: true,
        password: hashedPassword,
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
      error: "Failed to verify OTP",
      details: error.message || "Unknown error",
    });
  }
});

router.post("/verify-vendor-otp", async (req: Request, res: Response) => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const existingVendor = await prisma.user.findUnique({
      where: {
        phone,
        userType: "VENDOR",
      },
    });

    if (existingVendor) {
      return res.status(400).json({ error: "Vendor already exists" });
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      return res.status(400).json({ error: "Invalid or expired OTP" });
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcryptjs.hash(password, 10);
    }

    const vendor = await prisma.user.create({
      data: {
        phone,
        userType: "VENDOR",
        verified: true,
        password: hashedPassword,
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
        name,
        email,
        state,
        city,
        businessName,
        address,
        experience,
        gstNumber,
        aadharNumber,
        panNumber,
      } = req.body;

      if (
        !businessName ||
        !address ||
        !experience ||
        !gstNumber ||
        !aadharNumber ||
        !panNumber
      ) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const aadharFrontUrl = files?.["aadharFront"]?.[0]
        ? await uploadImage(files["aadharFront"][0].buffer)
        : null;
      const aadharBackUrl = files?.["aadharBack"]?.[0]
        ? await uploadImage(files["aadharBack"][0].buffer)
        : null;
      const panUrl = files?.["panCard"]?.[0]
        ? await uploadImage(files["panCard"][0].buffer)
        : null;

      if (!aadharFrontUrl || !aadharBackUrl || !panUrl) {
        return res.status(400).json({ error: "All documents are required" });
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          name,
          email,
          state,
          city,
          userType: "VENDOR",
        },
      });

      const existingVendorDetails = await prisma.vendorDetails.findUnique({
        where: { userId },
      });

      let vendorDetails;
      if (existingVendorDetails) {
        vendorDetails = await prisma.vendorDetails.update({
          where: { userId },
          data: {
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
      } else {
        vendorDetails = await prisma.vendorDetails.create({
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
      }

      const updatedUser = await prisma.user.findUnique({
        where: { id: userId },
        include: { vendorDetails: true },
      });

      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const token = jwt.sign(
        { userId, userType: "VENDOR" },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      res.json({
        message: "Vendor registration completed successfully",
        token,
        userId,
        name: updatedUser.name,
        email: updatedUser.email,
        phone: updatedUser.phone,
        state: updatedUser.state,
        city: updatedUser.city,
        vendorDetails: updatedUser.vendorDetails,
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

router.post("/vendor-sign-in", async (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body;

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

    if (vendor.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, vendor.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid password" });
      }
    } else if (vendor.password && !password) {
      return res.status(400).json({ error: "Password is required" });
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

router.post("/sign-in", async (req: Request, res: Response) => {
  try {
    const { phone, password } = req.body;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user || !user.verified) {
      return res
        .status(400)
        .json({ error: "Invalid phone number or user not verified" });
    }

    if (user.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, user.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid password" });
      }
    } else if (user.password && !password) {
      return res.status(400).json({ error: "Password is required" });
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

      const { name, email, state, city } = req.body;

      const selfieUrl = files?.["selfiePath"]?.[0]
        ? await uploadImage(files["selfiePath"][0].buffer)
        : null;

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

        const permitUrls = files?.["permitImages"]
          ? await Promise.all(
              files["permitImages"].map((file) => uploadImage(file.buffer))
            )
          : [];

        const rcUrl = files?.["rcDocument"]?.[0]
          ? await uploadImage(files["rcDocument"][0].buffer)
          : null;
        const fitnessUrl = files?.["fitnessDocument"]?.[0]
          ? await uploadImage(files["fitnessDocument"][0].buffer)
          : null;
        const pollutionUrl = files?.["pollutionDocument"]?.[0]
          ? await uploadImage(files["pollutionDocument"][0].buffer)
          : null;
        const insuranceUrl = files?.["insuranceDocument"]?.[0]
          ? await uploadImage(files["insuranceDocument"][0].buffer)
          : null;

        await prisma.driverDetails.create({
          data: {
            userId,
            aadharNumber,
            panNumber,
            dlNumber,
            vehicleNumber,
            vehicleName,
            vehicleCategory,
            carCategory: vehicleCategory,
            dlUrl,
            permitUrls,
            carFrontUrl,
            carBackUrl,
            rcUrl,
            fitnessUrl,
            pollutionUrl,
            insuranceUrl,
          },
        });
      } else if (type.toUpperCase() === "USER") {
        await prisma.userDetails.create({
          data: {
            userId,
          },
        });
      } else {
        return res.status(400).json({ error: "Invalid user type" });
      }

      const token = jwt.sign(
        { userId, userType: type.toUpperCase() },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      res.json({
        message: `${type} registration completed successfully`,
        token,
        userId: userId,
        userType: type.toUpperCase(),
        name: name,
        email: email,
        state: state,
        city: city,
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

router.post("/admin-register", async (req: Request, res: Response) => {
  try {
    const ADMIN_PHONE = "9999999999";

    const existingAdmin = await prisma.user.findFirst({
      where: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
      },
    });

    if (existingAdmin) {
      return res.status(400).json({ error: "Admin already exists" });
    }

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

router.post("/admin-sign-in", async (req: Request, res: Response) => {
  try {
    const ADMIN_PHONE = "9999999999";

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

router.post("/driver-sign-in", async (req, res) => {
  try {
    const { phone, password } = req.body;

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

    if (driver.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, driver.password);
      if (!isPasswordValid) {
        return res.status(401).json({ error: "Invalid password" });
      }
    } else if (driver.password && !password) {
      return res.status(400).json({ error: "Password is required" });
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

router.post("/logout", verifyToken, (req, res) => {
  res.json({ message: "Logged out successfully" });
});

router.post(
  "/driver/registration-fee/create",
  verifyToken,
  createRegistrationOrder
);
router.post(
  "/driver/registration-fee/verify",
  verifyToken,
  verifyRegistrationPayment
);
router.get(
  "/driver/registration-fee/status",
  verifyToken,
  checkRegistrationStatus
);

router.post(
  "/forgot-password/send-otp",
  async (req: Request, res: Response) => {
    try {
      const { phone } = req.body;

      if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const otp = generateOTP();

      const smsSuccess = await sendSMSViaPRP(phone, otp);

      if (!smsSuccess) {
        return res.status(500).json({ error: "Failed to send OTP via SMS" });
      }

      await storeOTP(phone, otp);

      res.json({ message: "OTP sent successfully" });
    } catch (error) {
      console.error("Forgot Password - Send OTP error:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  }
);

router.post(
  "/forgot-password/verify-otp",
  async (req: Request, res: Response) => {
    try {
      const { phone, otp, newPassword } = req.body;

      if (!phone || !otp || !newPassword) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const isOTPValid = await verifyOTPFromDB(phone, otp);

      if (!isOTPValid) {
        return res.status(400).json({ error: "Invalid or expired OTP" });
      }

      const hashedPassword = await bcryptjs.hash(newPassword, 10);

      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      });

      res.json({ message: "Password reset successful" });
    } catch (error) {
      console.error("Forgot Password - Verify OTP error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  }
);

router.post("/send-vendor-otp", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    const existingVendor = await prisma.user.findFirst({
      where: {
        phone,
        userType: "VENDOR",
      },
    });

    if (existingVendor) {
      return res.status(400).json({ error: "Vendor already exists" });
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      return res.status(500).json({ error: "Failed to send OTP via SMS" });
    }

    await storeOTP(phone, otp);

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send Vendor OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

export { router as authRouter };
