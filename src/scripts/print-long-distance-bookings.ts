import { prisma } from "../lib/prisma";

async function main() {
  try {
    const bookings = await prisma.longDistanceBooking.findMany({
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            email: true,
            driverDetails: {
              select: {
                vehicleCategory: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: "desc", // Show newest bookings first
      },
    });

    if (bookings.length === 0) {
      console.log("No long distance bookings found.");
    } else {
      console.log("Long Distance Bookings:");
      bookings.forEach((booking, index) => {
        console.log(`\n--- Booking ${index + 1} ---`);
        console.log(JSON.stringify(booking, null, 2));
      });
    }
  } catch (error) {
    console.error("Error fetching long distance bookings:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
