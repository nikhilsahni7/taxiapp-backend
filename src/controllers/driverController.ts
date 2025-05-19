import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import { uploadImage } from "../config/cloudinary";

interface UpdateDriverProfileBody {
  name?: string;
  email?: string;
  state?: string;
  city?: string;
  aadharNumber?: string;
  panNumber?: string;
  dlNumber?: string;
  vehicleNumber?: string;
  vehicleName?: string;
  vehicleCategory?: string;
  hasCarrier?: string;
}

const prisma = new PrismaClient();

interface FileWithBuffer extends Express.Multer.File {
  buffer: Buffer;
}

interface MulterFiles {
  [fieldname: string]: FileWithBuffer[];
}

interface UpdateDriverProfileBody {
  name?: string;
  email?: string;
  state?: string;
  city?: string;
  aadharNumber?: string;
  panNumber?: string;
  dlNumber?: string;
  vehicleNumber?: string;
  vehicleName?: string;
  vehicleCategory?: string;
  hasCarrier?: string;
}

export const getDriverRideHistory = async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Get regular rides
    const regularRides = await prisma.ride.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        fare: true,
        distance: true,
        duration: true,
        totalAmount: true,
        paymentMode: true,
        paymentStatus: true,
        rideType: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get long distance rides
    const longDistanceRides = await prisma.longDistanceBooking.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        serviceType: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        distance: true,
        duration: true,
        startDate: true,
        endDate: true,
        totalAmount: true,
        advancePaymentStatus: true,
        finalPaymentStatus: true,
        finalPaymentMode: true,
        tripType: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get vendor rides
    const vendorRides = await prisma.vendorBooking.findMany({
      where: {
        driverId: driverId,
      },
      select: {
        id: true,
        serviceType: true,
        status: true,
        pickupLocation: true,
        dropLocation: true,
        distance: true,
        duration: true,
        startDate: true,
        endDate: true,
        driverPayout: true,
        tripType: true,
        createdAt: true,
        vendor: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
      skip,
      take: Number(limit),
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get counts for pagination
    const [regularCount, longDistanceCount, vendorCount] = await Promise.all([
      prisma.ride.count({ where: { driverId } }),
      prisma.longDistanceBooking.count({ where: { driverId } }),
      prisma.vendorBooking.count({ where: { driverId } }),
    ]);

    // Calculate earnings
    const totalEarnings = await prisma.ride.aggregate({
      where: {
        driverId,
        paymentStatus: "COMPLETED",
        status: "RIDE_ENDED",
      },
      _sum: {
        totalAmount: true,
      },
    });

    const longDistanceEarnings = await prisma.longDistanceBooking.aggregate({
      where: {
        driverId,
        finalPaymentStatus: "COMPLETED",
      },
      _sum: {
        totalAmount: true,
      },
    });

    const vendorEarnings = await prisma.vendorBooking.aggregate({
      where: {
        driverId,
        status: "COMPLETED",
      },
      _sum: {
        driverPayout: true,
      },
    });

    const response = {
      regularRides: {
        rides: regularRides,
        total: regularCount,
      },
      longDistanceRides: {
        rides: longDistanceRides,
        total: longDistanceCount,
      },
      vendorRides: {
        rides: vendorRides,
        total: vendorCount,
      },
      earnings: {
        regularRides: totalEarnings._sum.totalAmount || 0,
        longDistanceRides: longDistanceEarnings._sum.totalAmount || 0,
        vendorRides: vendorEarnings._sum.driverPayout || 0,
        total:
          (totalEarnings._sum.totalAmount || 0) +
          (longDistanceEarnings._sum.totalAmount || 0) +
          (vendorEarnings._sum.driverPayout || 0),
      },
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(
          Math.max(regularCount, longDistanceCount, vendorCount) / Number(limit)
        ),
        limit: Number(limit),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching driver ride history:", error);
    res.status(500).json({ error: "Failed to fetch driver ride history" });
  }
};

export const updateDriverProfile = async (req: Request, res: Response) => {
  try {
    // Debug information
    console.log("Update driver profile request:", {
      user: req.user,
      body: req.body,
      files: req.files ? "Files present" : "No files",
    });

    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = req.user.userId;
    console.log("Driver ID from token:", userId);

    // Add validation for userId
    if (!userId) {
      return res
        .status(400)
        .json({ error: "User ID is missing in the request" });
    }

    // Check if user exists before proceeding
    console.log("Looking for user with ID:", userId);
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!userExists) {
      console.log("User not found with ID:", userId);
      return res.status(404).json({ error: "User not found" });
    }

    console.log("User found:", userExists.id, userExists.phone);

    const files = req.files as MulterFiles | undefined;

    // Extract fields from request body
    const body = req.body as UpdateDriverProfileBody;
    const {
      name,
      email,
      state,
      city,
      aadharNumber,
      panNumber,
      dlNumber,
      vehicleNumber,
      vehicleName,
      vehicleCategory,
      hasCarrier,
    } = body;

    console.log("Starting transaction to update user and driver details");

    try {
      // Start a transaction to ensure data consistency
      const [updatedUser, driverDetails] = await prisma.$transaction(
        async (tx) => {
          // Update user basic info - only include fields that are provided
          const updateData: Record<string, any> = {};

          if (name !== undefined) updateData.name = name;
          if (email !== undefined) updateData.email = email;
          if (state !== undefined) updateData.state = state;
          if (city !== undefined) updateData.city = city;

          if (files?.selfiePath?.[0]) {
            updateData.selfieUrl = await uploadImage(
              files.selfiePath[0].buffer
            );
          }

          console.log("Updating user with data:", updateData);

          const user = await tx.user.update({
            where: { id: userId },
            data: updateData,
          });

          // Handle document uploads
          const uploadPromises: Array<Promise<[string, string]>> = [];

          // Helper function to safely handle file uploads
          const handleFileUpload = async (
            file: Express.Multer.File | undefined,
            field: string
          ): Promise<[string, string] | null> => {
            if (!file || !("buffer" in file) || !file.buffer) return null;

            try {
              const url = await uploadImage(file.buffer);
              return [field, url];
            } catch (error) {
              console.error(`Error uploading ${field}:`, error);
              return null;
            }
          };

          // Process each file upload
          const fileUploads = [
            { files: files?.dlPath, field: "dlUrl" },
            { files: files?.carFront, field: "carFrontUrl" },
            { files: files?.carBack, field: "carBackUrl" },
            { files: files?.rcDocument, field: "rcUrl" },
            { files: files?.fitnessDocument, field: "fitnessUrl" },
            { files: files?.pollutionDocument, field: "pollutionUrl" },
            { files: files?.insuranceDocument, field: "insuranceUrl" },
          ];

          // Process file uploads in parallel
          const fileUploadResults = await Promise.all(
            fileUploads.map(async ({ files: fileArray, field }) => {
              if (!fileArray?.[0]) return null;
              return handleFileUpload(fileArray[0], field);
            })
          );

          // Add successful uploads to the promises array
          for (const result of fileUploadResults) {
            if (result) {
              uploadPromises.push(Promise.resolve(result));
            }
          }

          // Handle permit images (multiple)
          const permitUrls: string[] = [];
          if (files?.permitImages?.length) {
            const validPermitFiles = files.permitImages.filter(
              (file): file is Express.Multer.File & { buffer: Buffer } =>
                Boolean(file && "buffer" in file && file.buffer)
            );

            const permitUploads = validPermitFiles.map(async (file) => {
              try {
                return await uploadImage(file.buffer);
              } catch (error) {
                console.error("Error uploading permit image:", error);
                return null;
              }
            });

            const uploadedUrls = await Promise.all(permitUploads);
            for (const url of uploadedUrls) {
              if (url) permitUrls.push(url);
            }
          }

          // Wait for all uploads to complete
          const allUploadResults = await Promise.all(uploadPromises);
          const uploadData = Object.fromEntries(
            allUploadResults.filter(
              (result): result is [string, string] => result !== null
            )
          );

          // Prepare driver details update data
          const driverData: Record<string, any> = {
            ...(aadharNumber && { aadharNumber }),
            ...(panNumber && { panNumber }),
            ...(dlNumber && { dlNumber }),
            ...(vehicleNumber && { vehicleNumber }),
            ...(vehicleName && { vehicleName }),
            ...(vehicleCategory && { vehicleCategory }),
            ...(hasCarrier !== undefined && {
              hasCarrier: hasCarrier === "true",
            }),
            ...uploadData,
          };

          // Only add permitUrls if we have any
          if (permitUrls.length > 0) {
            driverData.permitUrls = permitUrls;
          }

          // Update or create driver details
          const details = await tx.driverDetails.upsert({
            where: { userId },
            update: driverData,
            create: {
              userId,
              ...driverData,
            },
          });

          return [user, details];
        }
      );

      // Get updated user with details for response
      const updatedUserWithDetails = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          driverDetails: true,
        },
      });

      res.json({
        message: "Profile updated successfully",
        user: updatedUserWithDetails,
      });
    } catch (error: any) {
      // Handle Prisma-specific errors
      if (error.code === "P2025") {
        console.error("User not found during update transaction:", error);
        return res.status(404).json({
          error: "User not found or was deleted during the update process",
          details: error.message,
        });
      }
      // Re-throw other errors to be caught by outer catch
      throw error;
    }
  } catch (error) {
    console.error("Error updating driver profile:", error);
    res.status(500).json({
      error: "Failed to update profile",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getAllDriverInfo = async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userId = req.user.userId;

    // Get user details with driver details
    const driverWithAllDetails = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        driverDetails: true,
        driverStatus: true,
      },
    });

    if (!driverWithAllDetails) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Check if user is a driver
    if (driverWithAllDetails.userType !== "DRIVER") {
      return res.status(403).json({ error: "User is not a driver" });
    }

    res.json({
      success: true,
      driver: driverWithAllDetails,
    });
  } catch (error) {
    console.error("Error fetching driver profile:", error);
    res.status(500).json({
      error: "Failed to fetch driver profile",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const getDriverCurrentRide = async (req: Request, res: Response) => {
  try {
    const { driverId } = req.params;

    // Validate that the driver exists first
    const driverExists = await prisma.user.findUnique({
      where: {
        id: driverId,
        userType: "DRIVER",
      },
    });

    if (!driverExists) {
      return res.status(404).json({ error: "Driver not found" });
    }

    // Check regular rides
    const currentRegularRide = await prisma.ride.findFirst({
      where: {
        driverId,
        status: {
          in: ["ACCEPTED", "DRIVER_ARRIVED", "RIDE_STARTED", "PAYMENT_PENDING"],
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    // Check long distance bookings
    const currentLongDistanceRide = await prisma.longDistanceBooking.findFirst({
      where: {
        driverId,
        status: {
          in: [
            "DRIVER_ACCEPTED",
            "DRIVER_PICKUP_STARTED",
            "DRIVER_ARRIVED",
            "STARTED",
          ],
        },
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    // Check vendor bookings
    const currentVendorRide = await prisma.vendorBooking.findFirst({
      where: {
        driverId,
        status: {
          in: ["DRIVER_ACCEPTED", "STARTED"],
        },
      },
      include: {
        vendor: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    const currentRide = {
      regularRide: currentRegularRide,
      longDistanceRide: currentLongDistanceRide,
      vendorRide: currentVendorRide,
    };

    res.json(currentRide);
  } catch (error) {
    console.error("Error fetching driver's current ride:", error);
    res.status(500).json({ error: "Failed to fetch driver's current ride" });
  }
};
