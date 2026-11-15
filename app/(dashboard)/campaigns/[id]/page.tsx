import { CampaignReport } from "@/components/app/campaigns/campaign-report";

export const metadata = { title: "Campaign report" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CampaignReport id={id} />;
}
