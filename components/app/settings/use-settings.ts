"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/fetcher";
import { useUpgradePrompt } from "@/components/app/upgrade-modal";
import { SETTINGS_KEY, type OrgSettings } from "./types";

export function useSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api<OrgSettings>("/api/settings") });
}

export function useSaveSettings(successMsg = "Settings saved") {
  const qc = useQueryClient();
  const { handleError } = useUpgradePrompt();
  return useMutation({
    mutationFn: (json: Record<string, unknown>) => api<OrgSettings>("/api/settings", { method: "PATCH", json }),
    onSuccess: (d) => {
      qc.setQueryData(SETTINGS_KEY, d);
      toast.success(successMsg);
    },
    onError: (e: Error) => {
      if (!handleError(e)) toast.error(e.message);
    },
  });
}
