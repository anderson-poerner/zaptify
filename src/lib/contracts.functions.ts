import { createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";

const s = (max: number) => z.string().max(max);

const formSchema = z.object({
  tipo: s(100),
  contratanteNome: s(200),
  contratanteDoc: s(200),
  contratadoNome: s(200),
  contratadoDoc: s(200),
  contratadoEndereco: s(300).optional(),
  contratadoEmail: s(255).optional(),
  contratadoTelefone: s(50).optional(),
  descricao: s(5000),
  valor: s(100),
  pagamento: s(500),
  prazo: s(500),
  foro: s(200),
});

const GENERIC = "Não foi possível concluir a operação. Tente novamente.";

function fail(context: string, err: unknown): never {
  console.error(`[contracts] ${context}:`, err);
  throw new Error(GENERIC);
}

function maskCpf(cpf: string | null): string | null {
  if (!cpf) return cpf;
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return "***";
  return `***.${d.slice(3, 6)}.***-${d.slice(9)}`;
}

function isValidCpf(raw: string): boolean {
  const cpf = raw.replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export const createContract = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ form: formSchema }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("contracts")
      .insert({ form_data: data.form, status: "pending" })
      .select("id")
      .single();
    if (error || !row) fail("createContract", error);
    return { id: row.id as string };
  });

export const getContract = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("contracts")
      .select("id, form_data, status, signer_name, signer_cpf, signed_at, created_at")
      .eq("id", data.id)
      .maybeSingle();
    if (error) fail("getContract", error);
    if (!row) return null;
    return { ...row, signer_cpf: maskCpf(row.signer_cpf), signer_ip: null as string | null };
  });

// A tela "Meus Contratos" precisa do IP para o carimbo do PDF assinado.
export const getContractsByIds = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    if (data.ids.length === 0) return [];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("contracts")
      .select("id, form_data, status, signer_name, signer_cpf, signer_ip, signed_at, created_at")
      .in("id", data.ids)
      .order("created_at", { ascending: false });
    if (error) fail("getContractsByIds", error);
    return (rows ?? []).map((r) => ({ ...r, signer_cpf: maskCpf(r.signer_cpf) }));
  });

export const signContract = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(3).max(150),
        cpf: z.string().trim().max(20).refine(isValidCpf, "CPF inválido."),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    let ip = "";
    try {
      ip = getRequestIP({ xForwardedFor: true }) ?? "";
    } catch {
      try {
        const req = getRequest();
        ip =
          req?.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
          req?.headers.get("cf-connecting-ip") ||
          req?.headers.get("x-real-ip") ||
          "";
      } catch {
        ip = "";
      }
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const signedAt = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin
      .from("contracts")
      .update({
        status: "signed",
        signer_name: data.name,
        signer_cpf: data.cpf.replace(/\D/g, ""),
        signer_ip: ip,
        signed_at: signedAt,
      })
      .eq("id", data.id)
      .eq("status", "pending")
      .select("id");
    if (error) fail("signContract", error);
    if (!updated || updated.length === 0) {
      throw new Error("Este contrato já foi assinado ou não existe");
    }

    return { ok: true, signed_at: signedAt, ip };
  });
