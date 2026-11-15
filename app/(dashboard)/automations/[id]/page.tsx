"use client";

import { use } from "react";
import { AutomationBuilder } from "@/components/app/automations/builder";

export default function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <AutomationBuilder id={id} />;
}
