import { PrismaClient, UserType } from "@prisma/client";

const prisma = new PrismaClient();

export const getAllUsersWithDetails = async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        userDetails: true,
        driverDetails: {
          select: {
            aadharNumber: true,
            panNumber: true,
            dlNumber: true,
            vehicleNumber: true,
            vehicleName: true,
            vehicleCategory: true,
            carCategory: true,
            registrationFeePaid: true,
          },
        },
        vendorDetails: {
          select: {
            businessName: true,
            address: true,
            experience: true,
            gstNumber: true,
            aadharNumber: true,
            panNumber: true,
          },
        },
        wallet: {
          select: {
            balance: true,
            currency: true,
          },
        },
        driverStatus: {
          select: {
            isOnline: true,
            locationLat: true,
            locationLng: true,
            lastLocationUpdate: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Format the response
    const formattedUsers = users.map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      userType: user.userType,
      verified: user.verified,
      location: {
        state: user.state,
        city: user.city,
      },
      selfieUrl: user.selfieUrl,
      createdAt: user.createdAt,
      wallet: user.wallet,
      // Include type-specific details
      details:
        user.userType === UserType.DRIVER
          ? user.driverDetails
          : user.userType === UserType.VENDOR
          ? user.vendorDetails
          : user.userDetails,
      // Include driver status if applicable
      ...(user.userType === UserType.DRIVER && {
        driverStatus: user.driverStatus,
      }),
    }));

    // Group users by type
    const groupedUsers = {
      users: formattedUsers.filter((user) => user.userType === UserType.USER),
      drivers: formattedUsers.filter(
        (user) => user.userType === UserType.DRIVER
      ),
      vendors: formattedUsers.filter(
        (user) => user.userType === UserType.VENDOR
      ),
      admins: formattedUsers.filter((user) => user.userType === UserType.ADMIN),
    };

    // Include counts in response
    const counts = {
      totalUsers: groupedUsers.users.length,
      totalDrivers: groupedUsers.drivers.length,
      totalVendors: groupedUsers.vendors.length,
      totalAdmins: groupedUsers.admins.length,
    };

    res.json({
      counts,
      data: groupedUsers,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({
      error: "Failed to fetch users",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
