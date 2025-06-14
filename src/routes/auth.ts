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
  user?: {
    userId: string;
    userType: string;
    selfieUrl: string;
  };
}

import multer from "multer";
import { uploadImage, uploadMultipleImages, validateFile } from "../config/cloudinary";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();
const prisma = new PrismaClient();

const PRP_SMS_CONFIG = {
  apiKey: process.env.PRP_SMS_API_KEY,
  baseUrl: "https://api.bulksmsadmin.com/BulkSMSapi/keyApiSendSMS",
  sender: process.env.PRP_SMS_SENDER || "TXISRE",
  templateName: process.env.PRP_SMS_TEMPLATE_NAME || "OTP",
  peId: process.env.PRP_SMS_PE_ID,
  templateId: process.env.PRP_SMS_TEMPLATE_ID,
  useTemplateId: process.env.PRP_SMS_USE_TEMPLATE_ID === "true" || false, // Default to false for Template Name approach
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
    console.log(`🔧 Template Name: ${PRP_SMS_CONFIG.templateName}`);
    console.log(`👤 Sender: ${PRP_SMS_CONFIG.sender}`);
    console.log(`🆔 PE ID: ${PRP_SMS_CONFIG.peId}`);
    console.log(`📋 Template ID: ${PRP_SMS_CONFIG.templateId}`);
    console.log(`⚙️ Use Template ID: ${PRP_SMS_CONFIG.useTemplateId}`);

    let payload: any;
    let endpoint: string;

    if (
      PRP_SMS_CONFIG.useTemplateId &&
      PRP_SMS_CONFIG.peId &&
      PRP_SMS_CONFIG.templateId
    ) {
      // Use Template ID approach
      payload = {
        sender: PRP_SMS_CONFIG.sender,
        peId: PRP_SMS_CONFIG.peId,
        teId: PRP_SMS_CONFIG.templateId,
        message: `Welcome DEAR CUSTOMER, YOUR OTP FOR SECURE LOGIN IS ${otp}. Thank you for choosing TAXI SURE.`,
        smsReciever: [
          {
            reciever: formattedPhone,
          },
        ],
      };
      endpoint = `${PRP_SMS_CONFIG.baseUrl}/sendSMS`;
    } else {
      // Use Template Name approach (fallback)
      payload = {
        sender: PRP_SMS_CONFIG.sender,
        templateName: PRP_SMS_CONFIG.templateName,
        smsReciever: [
          {
            mobileNo: formattedPhone,
            templateParams: `${otp}`,
          },
        ],
      };
      endpoint = `${PRP_SMS_CONFIG.baseUrl}/SendSmsTemplateName`;
    }

    console.log("📤 SMS Payload:", JSON.stringify(payload, null, 2));
    console.log(`🎯 OTP Value being sent: "${otp}"`);

    const response = await axios.post(endpoint, payload, {
      headers: {
        apikey: PRP_SMS_CONFIG.apiKey,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    console.log("✅ PRP SMS Response Status:", response.status);
    console.log("📋 PRP SMS Response Data:", response.data);

    // If SMS was sent successfully, check delivery report after a short delay
    if (response.data.isSuccess && response.data.data) {
      setTimeout(async () => {
        try {
          console.log("🔍 Checking SMS delivery status...");

          // Extract message ID from response data
          const messageId = response.data.data;

          // Create form data for delivery report
          const formData = new URLSearchParams();
          formData.append("searchMobile", formattedPhone);
          formData.append("Fromdate", new Date().toISOString().split("T")[0]);
          formData.append("Todate", new Date().toISOString().split("T")[0]);
          if (messageId) {
            formData.append("Msgid", messageId);
          }

          const deliveryResponse = await axios.post(
            `${PRP_SMS_CONFIG.baseUrl}/APIDeliveryReport`,
            formData,
            {
              headers: {
                Apikey: PRP_SMS_CONFIG.apiKey,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              timeout: 10000,
            }
          );
          console.log("📊 Delivery Report:", deliveryResponse.data);
        } catch (deliveryError: any) {
          console.error(
            "❌ Delivery Report Error:",
            deliveryError.response?.data || deliveryError.message
          );
        }
      }, 5000); // Check after 5 seconds
    }

    // Check for specific error responses
    if (response.data && response.data.returnMessage) {
      if (response.data.returnMessage.includes("TempName does not exists")) {
        console.error(
          `❌ Template '${PRP_SMS_CONFIG.templateName}' does not exist in SMS panel`
        );
        console.error(
          "📝 Please create and approve the template in your PRP SMS dashboard"
        );
        console.error(
          "🔧 Or update the PRP_SMS_TEMPLATE_NAME environment variable"
        );
        return false;
      }
    }

    // Check for success conditions based on API documentation
    const isSuccess =
      response.status === 200 &&
      (response.data.isSuccess === true ||
        response.data.status === "success" ||
        response.data.message === "SMS sent successfully.");

    if (isSuccess) {
      console.log("🎉 SMS sent successfully!");
      return true;
    } else {
      console.error(
        "❌ SMS sending failed:",
        response.data.returnMessage || response.data.message
      );

      if (process.env.NODE_ENV === "production") {
        return false;
      } else {
        console.log(
          "⚠️ Development mode: Allowing flow to continue despite SMS failure"
        );
        return true;
      }
    }
  } catch (error: any) {
    console.error("💥 PRP SMS Error:", error.response?.data || error.message);

    if (process.env.NODE_ENV === "production") {
      return false;
    } else {
      console.log(
        "⚠️ Development mode: Allowing flow to continue despite SMS error"
      );
      return true;
    }
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

// Enhanced multer configuration with file validation
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 20, // Maximum number of files
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: ${allowedTypes.join(', ')}`));
    }
  }
});

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

// Helper function to handle file uploads with validation
const handleFileUpload = async (file: Express.Multer.File | undefined): Promise<string | null> => {
  if (!file) return null;

  try {
    validateFile(file);
    return await uploadImage(file.buffer);
  } catch (error: any) {
    console.error(`❌ File upload failed for ${file.originalname}:`, error.message);
    throw new Error(`Failed to upload ${file.originalname}: ${error.message}`);
  }
};

// Helper function to check for duplicate users
const checkDuplicateUser = async (phone: string, userType: string): Promise<boolean> => {
  const existingUser = await prisma.user.findFirst({
    where: {
      phone,
      userType: userType as any,
    },
  });
  return !!existingUser;
};

router.post("/send-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone } = req.body;

    const existingUser = await prisma.user.findFirst({
      where: {
        phone,
      },
    });

    if (existingUser) {
      res.json({
        message: "User already exists",
        existingUser: true,
        userType: existingUser.userType,
      });
      return;
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      res.status(500).json({ error: "Failed to send OTP via SMS" });
      return;
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

router.post("/verify-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      res.status(400).json({ error: "User already exists" });
      return;
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
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

    // Create wallet for the user
    await prisma.wallet.create({
      data: {
        userId: user.id,
        balance: 0,
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

router.post("/send-driver-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone } = req.body;

    if (!phone) {
      res.status(400).json({ error: "Phone number is required" });
      return;
    }

    const isDuplicate = await checkDuplicateUser(phone, "DRIVER");
    if (isDuplicate) {
      res.status(400).json({ error: "Driver already exists" });
      return;
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      res.status(500).json({ error: "Failed to send OTP via SMS" });
      return;
    }

    await storeOTP(phone, otp);

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send Driver OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

router.post("/verify-driver-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const formattedPhone = phone.startsWith("+") ? phone : `+${phone}`;

    // Check for duplicate with transaction
    const isDuplicate = await checkDuplicateUser(formattedPhone, "DRIVER");
    if (isDuplicate) {
      res.status(400).json({ error: "Driver already exists" });
      return;
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcryptjs.hash(password, 10);
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      const driver = await tx.user.create({
        data: {
          phone: formattedPhone,
          userType: "DRIVER",
          verified: true,
          password: hashedPassword,
        },
      });

      // Create wallet for the driver
      await tx.wallet.create({
        data: {
          userId: driver.id,
          balance: 0,
        },
      });

      return driver;
    });

    const token = jwt.sign(
      { userId: result.id, userType: result.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      userId: result.id,
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

router.post("/verify-vendor-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, otp, password } = req.body;

    if (!phone || !otp) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const isDuplicate = await checkDuplicateUser(phone, "VENDOR");
    if (isDuplicate) {
      res.status(400).json({ error: "Vendor already exists" });
      return;
    }

    const isOTPValid = await verifyOTPFromDB(phone, otp);

    if (!isOTPValid) {
      res.status(400).json({ error: "Invalid or expired OTP" });
      return;
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcryptjs.hash(password, 10);
    }

    // Use transaction
    const result = await prisma.$transaction(async (tx) => {
      const vendor = await tx.user.create({
        data: {
          phone,
          userType: "VENDOR",
          verified: true,
          password: hashedPassword,
        },
      });

      // Create wallet for the vendor
      await tx.wallet.create({
        data: {
          userId: vendor.id,
          balance: 0,
        },
      });

      return vendor;
    });

    const token = jwt.sign(
      { userId: result.id, userType: result.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      userId: result.id,
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
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
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
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      // Upload files with proper error handling
      const aadharFrontUrl = await handleFileUpload(files?.["aadharFront"]?.[0]);
      const aadharBackUrl = await handleFileUpload(files?.["aadharBack"]?.[0]);
      const panUrl = await handleFileUpload(files?.["panCard"]?.[0]);

      if (!aadharFrontUrl || !aadharBackUrl || !panUrl) {
        res.status(400).json({ error: "All documents are required" });
        return;
      }

      // Use transaction for vendor registration
      const result = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: {
            name,
            email,
            state,
            city,
            userType: "VENDOR",
          },
        });

        const existingVendorDetails = await tx.vendorDetails.findUnique({
          where: { userId },
        });

        let vendorDetails;
        if (existingVendorDetails) {
          vendorDetails = await tx.vendorDetails.update({
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
          vendorDetails = await tx.vendorDetails.create({
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

        const updatedUser = await tx.user.findUnique({
          where: { id: userId },
          include: { vendorDetails: true },
        });

        return updatedUser;
      });

      if (!result) {
        res.status(404).json({ error: "User not found" });
        return;
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
        name: result.name,
        email: result.email,
        phone: result.phone,
        state: result.state,
        city: result.city,
        vendorDetails: result.vendorDetails,
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

router.post("/vendor-sign-in", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password } = req.body;

    if (!phone) {
      res.status(400).json({ error: "Phone number is required" });
      return;
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
      res.status(401).json({
        error: "Invalid phone number or vendor not verified",
        vendor: vendor,
        vendorDetails: vendor?.vendorDetails,
      });
      return;
    }

    if (vendor.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, vendor.password);
      if (!isPasswordValid) {
        res.status(401).json({ error: "Invalid password" });
        return;
      }
    } else if (vendor.password && !password) {
      res.status(400).json({ error: "Password is required" });
      return;
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

router.post("/sign-in", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password } = req.body;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user || !user.verified) {
      res
        .status(400)
        .json({ error: "Invalid phone number or user not verified" });
      return;
    }

    if (user.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, user.password);
      if (!isPasswordValid) {
        res.status(401).json({ error: "Invalid password" });
        return;
      }
    } else if (user.password && !password) {
      res.status(400).json({ error: "Password is required" });
      return;
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
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const { type } = req.params;
      const userId = req.user.userId;
      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined;

      console.log(`🚀 Starting ${type} registration for user ${userId}`);

      const { name, email, state, city } = req.body;

      // Validate required fields
      if (!name || !state || !city) {
        res.status(400).json({ error: "Name, state, and city are required" });
        return;
      }

      // Upload selfie with validation
      const selfieUrl = await handleFileUpload(files?.["selfiePath"]?.[0]);

      // Start transaction for registration
      const result = await prisma.$transaction(async (tx) => {
        // Update user details
        await tx.user.update({
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
            hasCarrier,
          } = req.body;

          // Validate required driver fields
          if (!aadharNumber || !panNumber || !dlNumber || !vehicleNumber || !vehicleName || !vehicleCategory) {
            throw new Error("Missing required driver fields");
          }

          console.log("📄 Processing driver documents...");

          // Upload individual documents with proper error handling
          const dlUrl = await handleFileUpload(files?.["dlPath"]?.[0]);
          const carFrontUrl = await handleFileUpload(files?.["carFront"]?.[0]);
          const carBackUrl = await handleFileUpload(files?.["carBack"]?.[0]);
          const rcUrl = await handleFileUpload(files?.["rcDocument"]?.[0]);
          const fitnessUrl = await handleFileUpload(files?.["fitnessDocument"]?.[0]);
          const pollutionUrl = await handleFileUpload(files?.["pollutionDocument"]?.[0]);
          const insuranceUrl = await handleFileUpload(files?.["insuranceDocument"]?.[0]);

          // Upload permit images (multiple files)
          let permitUrls: string[] = [];
          if (files?.["permitImages"]) {
            try {
              permitUrls = await uploadMultipleImages(files["permitImages"]);
              console.log(`✅ Uploaded ${permitUrls.length} permit images`);
            } catch (error: any) {
              console.error("❌ Failed to upload permit images:", error.message);
              throw new Error(`Failed to upload permit images: ${error.message}`);
            }
          }

          // Create driver details
          await tx.driverDetails.create({
            data: {
              userId,
              aadharNumber,
              panNumber,
              dlNumber,
              vehicleNumber,
              vehicleName,
              vehicleCategory,
              carCategory: vehicleCategory,
              hasCarrier: hasCarrier === "true" || hasCarrier === true,
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

          console.log("✅ Driver details created successfully");

        } else if (type.toUpperCase() === "USER") {
          await tx.userDetails.create({
            data: {
              userId,
            },
          });
        } else {
          throw new Error("Invalid user type");
        }

        return { userId, userType: type.toUpperCase(), name, email, state, city };
      }, {
        timeout: 60000, // 60 second timeout for transaction
      });

      const token = jwt.sign(
        { userId, userType: type.toUpperCase() },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" }
      );

      console.log(`🎉 ${type} registration completed successfully for user ${userId}`);

      res.json({
        message: `${type} registration completed successfully`,
        token,
        userId: userId,
        userType: type.toUpperCase(),
        name: result.name,
        email: result.email,
        state: result.state,
        city: result.city,
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

router.post("/admin-register", async (req: Request, res: Response): Promise<void> => {
  try {
    const ADMIN_PHONE = "9999999999";

    const existingAdmin = await prisma.user.findFirst({
      where: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
      },
    });

    if (existingAdmin) {
      res.status(400).json({ error: "Admin already exists" });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      const admin = await tx.user.create({
        data: {
          phone: ADMIN_PHONE,
          userType: "ADMIN",
          verified: true,
          name: "Admin",
        },
      });

      // Create wallet for the admin
      await tx.wallet.create({
        data: {
          userId: admin.id,
          balance: 0,
        },
      });

      return admin;
    });

    const token = jwt.sign(
      { userId: result.id, userType: result.userType },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Admin registered successfully",
      token,
      adminId: result.id,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to register admin" });
  }
});

router.post("/admin-sign-in", async (req: Request, res: Response): Promise<void> => {
  try {
    const ADMIN_PHONE = "9999999999";

    const admin = await prisma.user.findFirst({
      where: {
        phone: ADMIN_PHONE,
        userType: "ADMIN",
      },
    });

    if (!admin) {
      res.status(401).json({ error: "Admin not found" });
      return;
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

router.post("/driver-sign-in", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password } = req.body;

    if (!phone) {
      res.status(400).json({ error: "Phone number is required" });
      return;
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
      res
        .status(401)
        .json({ error: "Invalid phone number or driver not verified" });
      return;
    }

    if (driver.password && password) {
      const isPasswordValid = await bcryptjs.compare(password, driver.password);
      if (!isPasswordValid) {
        res.status(401).json({ error: "Invalid password" });
        return;
      }
    } else if (driver.password && !password) {
      res.status(400).json({ error: "Password is required" });
      return;
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

router.post("/logout", verifyToken, (req: Request, res: Response): void => {
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
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { phone } = req.body;

      if (!phone) {
        res.status(400).json({ error: "Phone number is required" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const otp = generateOTP();

      const smsSuccess = await sendSMSViaPRP(phone, otp);

      if (!smsSuccess) {
        res.status(500).json({ error: "Failed to send OTP via SMS" });
        return;
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
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { phone, otp, newPassword } = req.body;

      if (!phone || !otp || !newPassword) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const isOTPValid = await verifyOTPFromDB(phone, otp);

      if (!isOTPValid) {
        res.status(400).json({ error: "Invalid or expired OTP" });
        return;
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

router.post("/send-vendor-otp", async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone } = req.body;

    if (!phone) {
      res.status(400).json({ error: "Phone number is required" });
      return;
    }

    const isDuplicate = await checkDuplicateUser(phone, "VENDOR");
    if (isDuplicate) {
      res.status(400).json({ error: "Vendor already exists" });
      return;
    }

    const otp = generateOTP();

    const smsSuccess = await sendSMSViaPRP(phone, otp);

    if (!smsSuccess) {
      res.status(500).json({ error: "Failed to send OTP via SMS" });
      return;
    }

    await storeOTP(phone, otp);

    res.json({ message: "OTP sent successfully" });
  } catch (error) {
    console.error("Send Vendor OTP error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

export { router as authRouter };
