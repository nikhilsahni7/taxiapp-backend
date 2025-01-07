import { PrismaClient, UserType } from "@prisma/client";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const prisma = new PrismaClient();

// Define interfaces for our data structures
interface VendorInput {
  name: string;
  phone: string;
  email: string;
  businessName: string;
  address: string;
  city: string;
  state: string;
  aadharNumber: string;
  panNumber: string;
  gstNumber: string;
  experience: string;
}

interface CreatedVendor {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  businessName: string | null;
  city: string | null;
  state: string | null;
  walletBalance: number | undefined;
  token: string;
}

function generateToken(userId: string, userType: UserType): string {
  return jwt.sign(
    { userId, userType },
    process.env.JWT_SECRET || "your-default-secret",
    { expiresIn: "30d" }
  );
}

// Helper to generate random Indian mobile number
function generateIndianMobile(): string {
  const prefixes = ["91", "70", "72", "73", "74", "75", "76", "77", "78", "79"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = Math.floor(Math.random() * 100000000)
    .toString()
    .padStart(8, "0");
  return prefix + number;
}

// Helper to generate Aadhaar number
function generateAadhaar(): string {
  const num = Math.floor(Math.random() * 1000000000000)
    .toString()
    .padStart(12, "0");
  return `${num.slice(0, 4)}-${num.slice(4, 8)}-${num.slice(8)}`;
}

// Helper to generate PAN number
function generatePAN(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const first = letters[Math.floor(Math.random() * 26)];
  const second = letters[Math.floor(Math.random() * 26)];
  const third = letters[Math.floor(Math.random() * 26)];
  const numbers = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  const last = letters[Math.floor(Math.random() * 26)];
  return `${first}${second}${third}${numbers}${last}`;
}

async function main() {
  // Clean up existing data

  const vendors: VendorInput[] = [
    {
      name: "Rajesh Kumar Sharma",
      phone: generateIndianMobile(),
      email: "rajesh.sharma@gmail.com",
      businessName: "Sharma Tours & Travels",
      address: "Shop No. 123, Sector 18, Noida, Uttar Pradesh",
      city: "Noida",
      state: "Uttar Pradesh",
      aadharNumber: generateAadhaar(),
      panNumber: generatePAN(),
      gstNumber: "09AAACS8432H1ZA",
      experience: "15+ years in tourism",
    },
    {
      name: "Priya Patel",
      phone: generateIndianMobile(),
      email: "priya.patel@hotmail.com",
      businessName: "Gujarat Tourism Solutions",
      address: "A-45, Vastrapur, Ahmedabad, Gujarat",
      city: "Ahmedabad",
      state: "Gujarat",
      aadharNumber: generateAadhaar(),
      panNumber: generatePAN(),
      gstNumber: "24AALCS2346K1ZB",
      experience: "8+ years in tourism",
    },
    {
      name: "Mohammed Siddiqui",
      phone: generateIndianMobile(),
      email: "siddiqui.travels@yahoo.com",
      businessName: "Royal India Tours",
      address: "1st Floor, City Center Mall, Banjara Hills, Hyderabad",
      city: "Hyderabad",
      state: "Telangana",
      aadharNumber: generateAadhaar(),
      panNumber: generatePAN(),
      gstNumber: "36AADCS4567H1ZC",
      experience: "12+ years in tourism",
    },
  ];

  const mockUrls = {
    aadharFront: [
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_front_1.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_front_2.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_front_3.jpg",
    ],
    aadharBack: [
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_back_1.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_back_2.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/aadhar_back_3.jpg",
    ],
    pan: [
      "https://storage.googleapis.com/your-bucket/vendors/docs/pan_1.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/pan_2.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/docs/pan_3.jpg",
    ],
    selfie: [
      "https://storage.googleapis.com/your-bucket/vendors/selfies/vendor_1.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/selfies/vendor_2.jpg",
      "https://storage.googleapis.com/your-bucket/vendors/selfies/vendor_3.jpg",
    ],
  };

  const createdVendors: CreatedVendor[] = [];

  for (let i = 0; i < vendors.length; i++) {
    const vendorData = vendors[i];

    // Create user with vendor details
    const user = await prisma.user.create({
      data: {
        name: vendorData.name,
        phone: vendorData.phone,
        email: vendorData.email,
        userType: UserType.VENDOR,
        verified: true,
        city: vendorData.city,
        state: vendorData.state,
        selfieUrl: mockUrls.selfie[i],
        vendorDetails: {
          create: {
            businessName: vendorData.businessName,
            aadharNumber: vendorData.aadharNumber,
            panNumber: vendorData.panNumber,
            aadharFrontUrl: mockUrls.aadharFront[i],
            aadharBackUrl: mockUrls.aadharBack[i],
            panUrl: mockUrls.pan[i],
            experience: vendorData.experience,
            gstNumber: vendorData.gstNumber,
            address: vendorData.address,
          },
        },
        wallet: {
          create: {
            balance: Math.floor(Math.random() * 50000), // Random initial balance
            currency: "INR",
          },
        },
      },
      include: {
        vendorDetails: true,
        wallet: true,
      },
    });

    const token = generateToken(user.id, user.userType);

    createdVendors.push({
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      businessName: user.vendorDetails?.businessName!,
      city: user.city,
      state: user.state,
      walletBalance: user.wallet?.balance,
      token: token,
    });
  }

  console.log("\nSeeded Vendors:");
  console.table(
    createdVendors.map((v) => ({
      ...v,
      token: v.token.substring(0, 25) + "...", // Truncate token for display
    }))
  );

  // Print tokens separately for easy copying
  console.log("\nVendor Tokens (for testing):");
  createdVendors.forEach((vendor, index) => {
    console.log(`\nVendor ${index + 1}: ${vendor.businessName}`);
    console.log(`ID: ${vendor.id}`);
    console.log(`Token: ${vendor.token}`);
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
