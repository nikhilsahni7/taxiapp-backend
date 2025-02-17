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

async function cleanupLongDistanceData() {
  try {
    // Delete all Long Distance Transactions first
    await prisma.longDistanceTransaction.deleteMany({});

    // Then delete all Long Distance Bookings
    await prisma.longDistanceBooking.deleteMany({});

    console.log("All long distance data has been cleared.");
  } catch (error) {
    console.error("Error clearing long distance data:", error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanupLongDistanceData();
