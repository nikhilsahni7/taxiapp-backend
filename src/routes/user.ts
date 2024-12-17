import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import express from "express";

import { verifyToken } from "../middlewares/auth";

const router = express.Router();

const prisma = new PrismaClient();

//get  all user details

router.get("/", async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        userType: "USER",
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        selfieUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get user by ID
router.get("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        selfieUrl: true,
        state: true,
        city: true,
        userType: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update user
router.put("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;
    const { name, email, state, city } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        email,
        state,
        city,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        selfieUrl: true,
        state: true,
        city: true,
        userType: true,
        updatedAt: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: "Failed to update user" });
  }
});

// Delete user
router.delete("/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.user.userId;

    // First delete related records
    await prisma.userDetails.deleteMany({ where: { userId: userId } });
    await prisma.driverDetails.deleteMany({ where: { userId: userId } });
    await prisma.vendorDetails.deleteMany({ where: { userId: userId } });

    // Then delete the user
    await prisma.user.delete({ where: { id: userId } });

    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export { router as userRouter };
