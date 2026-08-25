-- Migration: Add description column to servers table
ALTER TABLE servers ADD COLUMN description TEXT DEFAULT NULL;
