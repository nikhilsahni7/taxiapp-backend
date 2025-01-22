// import { PrismaClient, UserType } from "@prisma/client";
// import bcrypt from "bcrypt";

// const prisma = new PrismaClient();

// async function main() {
//   const drivers = [
//     {
//       phone: "+919876543210", // Indian phone number format
//       password: "driver@123", // Secure password
//       name: "Amit Sharma",
//       email: "amit.sharma@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//       aadharNumber: "1234-5678-9012", // Aadhaar format
//       panNumber: "ABCDE1234F", // PAN format
//       dlNumber: "DL05 20230012345", // Delhi Driving License
//       vehicleNumber: "DL05AB1234", // Vehicle registration
//       vehicleName: "Maruti Suzuki Swift",
//       vehicleCategory: "Mini", // Updated category
//       locationLat: 28.632, // Near Connaught Place Latitude
//       locationLng: 77.2183, // Near Connaught Place Longitude
//     },
//     {
//       phone: "+919876543211",
//       password: "driver@456",
//       name: "Ramesh Kumar",
//       email: "ramesh.kumar@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//       aadharNumber: "5678-1234-9012",
//       panNumber: "FGHIJ5678K",
//       dlNumber: "DL05 20230067890",
//       vehicleNumber: "DL05CD5678",
//       vehicleName: "Hyundai Verna",
//       vehicleCategory: "Sedan", // Updated category
//       locationLat: 28.63, // Near Connaught Place Latitude
//       locationLng: 77.219, // Near Connaught Place Longitude
//     },
//     {
//       phone: "+919876543212",
//       password: "driver@789",
//       name: "Suresh Patil",
//       email: "suresh.patil@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//       aadharNumber: "9012-3456-7890",
//       panNumber: "KLMNO9012P",
//       dlNumber: "DL05 20230123456",
//       vehicleNumber: "DL05EF9012",
//       vehicleName: "Toyota Fortuner",
//       vehicleCategory: "SUV", // Updated category
//       locationLat: 28.633, // Near Connaught Place Latitude
//       locationLng: 77.2175, // Near Connaught Place Longitude
//     },
//   ];

//   // Create Drivers
//   for (const driverData of drivers) {
//     const user = await prisma.user.upsert({
//       where: { email: driverData.email },
//       update: {},
//       create: {
//         phone: driverData.phone,

//         name: driverData.name,
//         email: driverData.email,
//         userType: UserType.DRIVER,
//         verified: true,
//         state: driverData.state,
//         city: driverData.city,
//       },
//     });

//     await prisma.driverDetails.upsert({
//       where: { userId: user.id },
//       update: {
//         aadharNumber: driverData.aadharNumber,
//         panNumber: driverData.panNumber,
//         dlNumber: driverData.dlNumber,
//         vehicleNumber: driverData.vehicleNumber,
//         vehicleName: driverData.vehicleName,
//         vehicleCategory: driverData.vehicleCategory,
//       },
//       create: {
//         userId: user.id,
//         aadharNumber: driverData.aadharNumber,
//         panNumber: driverData.panNumber,
//         dlNumber: driverData.dlNumber,
//         vehicleNumber: driverData.vehicleNumber,
//         vehicleName: driverData.vehicleName,
//         vehicleCategory: driverData.vehicleCategory,
//       },
//     });

//     // Set Driver Status as Online with Location
//     await prisma.driverStatus.upsert({
//       where: { driverId: user.id },
//       update: {
//         isOnline: true,
//         locationLat: driverData.locationLat,
//         locationLng: driverData.locationLng,
//       },
//       create: {
//         driverId: user.id,
//         isOnline: true,
//         locationLat: driverData.locationLat,
//         locationLng: driverData.locationLng,
//       },
//     });
//   }

//   // Create Additional Users
//   const users = [
//     {
//       phone: "+919876543214",
//       password: "user@123",
//       name: "Neha Gupta",
//       email: "neha.gupta@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//     },
//     {
//       phone: "+919876543215",
//       password: "user@456",
//       name: "Rahul Mehta",
//       email: "rahul.mehta@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//     },
//     {
//       phone: "+919876543216",
//       password: "user@789",
//       name: "Priya Verma",
//       email: "priya.verma@example.com",
//       state: "Delhi",
//       city: "New Delhi",
//     },
//   ];

//   for (const userData of users) {
//     await prisma.user.upsert({
//       where: { email: userData.email },
//       update: {},
//       create: {
//         phone: userData.phone,

//         name: userData.name,
//         email: userData.email,
//         userType: UserType.USER,
//         verified: true,
//         state: userData.state,
//         city: userData.city,
//       },
//     });
//   }

//   console.log("Driver and user records added successfully.");
// }

// main()
//   .catch((e) => {
//     console.error(e);
//     process.exit(1);
//   })
//   .finally(async () => {
//     await prisma.$disconnect();
//   });

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // First, clear existing packages (optional)
  await prisma.carRentalPackage.deleteMany({});

  // Mini packages
  const miniPackages = [
    {
      name: "2-20",
      hours: 2,
      kilometers: 20,
      basePrice: 720,
      carType: "mini",
      extraKmRate: 14,
    },
    {
      name: "4-40",
      hours: 4,
      kilometers: 40,
      basePrice: 900,
      carType: "mini",
      extraKmRate: 14,
    },
    {
      name: "6-60",
      hours: 6,
      kilometers: 60,
      basePrice: 1200,
      carType: "mini",
      extraKmRate: 14,
    },
    {
      name: "8-80",
      hours: 8,
      kilometers: 80,
      basePrice: 2100,
      carType: "mini",
      extraKmRate: 14,
    },
  ];

  // Sedan packages
  const sedanPackages = [
    {
      name: "2-20",
      hours: 2,
      kilometers: 20,
      basePrice: 810,
      carType: "sedan",
      extraKmRate: 16,
    },
    {
      name: "4-40",
      hours: 4,
      kilometers: 40,
      basePrice: 950,
      carType: "sedan",
      extraKmRate: 16,
    },
    {
      name: "6-60",
      hours: 6,
      kilometers: 60,
      basePrice: 1400,
      carType: "sedan",
      extraKmRate: 16,
    },
    {
      name: "8-80",
      hours: 8,
      kilometers: 80,
      basePrice: 2400,
      carType: "sedan",
      extraKmRate: 16,
    },
  ];

  // SUV packages
  const suvPackages = [
    {
      name: "2-20",
      hours: 2,
      kilometers: 20,
      basePrice: 950,
      carType: "suv",
      extraKmRate: 18,
    },
    {
      name: "4-40",
      hours: 4,
      kilometers: 40,
      basePrice: 1150,
      carType: "suv",
      extraKmRate: 18,
    },
    {
      name: "6-60",
      hours: 6,
      kilometers: 60,
      basePrice: 1650,
      carType: "suv",
      extraKmRate: 18,
    },
    {
      name: "8-80",
      hours: 8,
      kilometers: 80,
      basePrice: 2700,
      carType: "suv",
      extraKmRate: 18,
    },
  ];

  console.log("Starting to seed car rental packages...");

  // Create all packages
  const allPackages = [...miniPackages, ...sedanPackages, ...suvPackages];

  for (const pkg of allPackages) {
    const created = await prisma.carRentalPackage.create({
      data: pkg,
    });
    console.log(
      `Created package: ${created.carType} ${created.name} with ID: ${created.id}`
    );
  }

  console.log("Seeding completed!");

  // Print all package IDs for reference
  const packages = await prisma.carRentalPackage.findMany({
    select: {
      id: true,
      name: true,
      carType: true,
    },
  });

  console.log("\nPackage IDs for reference:");
  packages.forEach((pkg) => {
    console.log(`${pkg.carType} ${pkg.name}: ${pkg.id}`);
  });
}

main()
  .catch((e) => {
    console.error("Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

// Package IDs for reference:
// mini 2-20: 110e729b-aba0-4d05-be57-703673d597e5
// mini 4-40: 939cbd17-8903-45a5-b8ae-fd1ec26fa675
// mini 6-60: 671f68b0-d9a0-49ff-9c88-80eb306f6bdf
// mini 8-80: 0f5110a4-ba6f-40f8-a237-6f708e16ca91
// sedan 2-20: 8528ba6b-748e-4670-9cfe-7d5e208ebbaf
// sedan 4-40: be2cca71-145a-466f-8a98-9fb18d07daf1
// sedan 6-60: ba3cba9d-852d-421f-baee-68b63a60f45f
// sedan 8-80: 212d0628-ae36-4ce8-9c62-0bca718aa7c5
// suv 2-20: 5d9f9b01-155f-4b80-954c-027ac1a909e1
// suv 4-40: cacbc679-7fce-4bba-a130-012a124eeecd
// suv 6-60: 808c0489-7339-4121-8be0-1489466596fe
// suv 8-80: 1bbfa3a1-0ed2-4bb1-a680-cf13bffe331c
