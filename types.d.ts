// types.d.ts
import express from "express";
import { Multer } from "multer";

declare global {
  namespace Express {
    interface Request {
      file?: Multer.File;
      files?: { [fieldname: string]: Multer.File[] };
      user?: {
        userId: string;
        userType: string;
      };
    }
  }
}
