import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
} from "@remix-run/cloudflare";
import { useLoaderData, Form } from "@remix-run/react";
import { TodoManager } from "~/to-do-manager";
import { useState, useCallback } from "react";

// --- CLIENT-SIDE ENCRYPTION/DECRYPTION UTILITIES ---

// AES-GCM parameters
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256; // 256-bit key
const IV_LENGTH = 12;   // 12 bytes IV (standard for GCM)

/**
 * Derives a crypto key from a passphrase string.
 * Uses a fixed salt and an iterative PBKDF2 function for key stretching.
 * This is a client-side key derivation for encryption/decryption, not for server auth.
 */
async function deriveKey(passphrase: string): Promise<CryptoKey> {
    // Use a fixed salt. Since the key is never sent to the server, this is acceptable
    // for this specific use case (client-side encryption only).
    const salt = new TextEncoder().encode("notes-app-fixed-salt");
    const iterations = 100000;
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: iterations,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: ALGORITHM, length: KEY_LENGTH },
        true,
        ["encrypt", "decrypt"]
    );
}

/**
 * Encrypts a message using AES-GCM and a derived key.
 * Prepends the Initialization Vector (IV) to the ciphertext for storage.
 * @returns A base64-encoded string: "IV.CIPHERTEXT"
 */
async function encryptMessage(message: string, key: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encodedMessage = new TextEncoder().encode(message);

    const ciphertext = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv: iv },
        key,
        encodedMessage
    );

    // Combine IV and Ciphertext, then base64 encode for string storage.
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts an AES-GCM ciphertext string with a derived key.
 * @param encrypted A base64-encoded string: "IV.CIPHERTEXT"
 * @returns The decrypted plaintext message.
 */
async function decryptMessage(encrypted: string, key: CryptoKey): Promise<string> {
    const combined = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
    
    // Check if the data is long enough to contain IV
    if (combined.length < IV_LENGTH) {
        throw new Error("Encrypted data is too short/malformed.");
    }

    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    const plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: iv },
        key,
        ciphertext
    );

    return new TextDecoder().decode(plaintext);
}

// --- REMIX LOADER AND ACTION (SERVER-SIDE) ---

export const loader = async ({ params, context }: LoaderFunctionArgs) => {
    const noteManager = new TodoManager(
        context.cloudflare.env.TO_DO_LIST,
        params.id,
    );
    const notes = await noteManager.list();
    return { notes };
};

export async function action({ request, context, params }: ActionFunctionArgs) {
    const noteManager = new TodoManager(
        context.cloudflare.env.TO_DO_LIST,
        params.id,
    );
    const formData = await request.formData();
    const intent = formData.get("intent");

    switch (intent) {
        case "create": {
            // Note: The text will be already encrypted (or plaintext) before being submitted.
            // The key is **not** sent to the server.
            const text = formData.get("text");
            if (typeof text !== "string" || !text)
                return Response.json({ error: "Invalid text" }, { status: 400 });
            await noteManager.create(text);
            return { success: true };
        }
        case "delete": {
            const id = formData.get("id") as string;
            await noteManager.delete(id);
            return { success: true };
        }
        default:
            return Response.json({ error: "Invalid intent" }, { status: 400 });
    }
}

// --- COMPONENT (CLIENT-SIDE) ---

// Define the shape of a decrypted note for state management
interface Note {
    id: string;
    text: string;
    encrypted: boolean; // Flag to track if the note was successfully decrypted
}

// Helper to check if a string looks like base64 (encrypted data)
// This is a heuristic, but helps distinguish between newly fetched plaintext and cipher text.
const isBase64 = (str: string) => {
    try {
        // Attempt base64 decoding (atob)
        const decoded = atob(str);
        // Check if the decoded string contains the combined IV/Ciphertext length
        return decoded.length >= IV_LENGTH;
    } catch (e) {
        return false;
    }
}

export default function () {
    const { notes: serverNotes } = useLoaderData<typeof loader>();
    const [decryptedNotes, setDecryptedNotes] = useState<Note[]>(
        serverNotes.map(note => ({ ...note, encrypted: isBase64(note.text) }))
    );
    const [encryptKey, setEncryptKey] = useState("");
    const [decryptKey, setDecryptKey] = useState("");

    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    /**
     * Handles form submission for creating a new note.
     * Encrypts the message if an encrypt key is provided, **before** submission.
     */
    const handleCreateSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        const form = event.currentTarget;
        const formData = new FormData(form);
        const text = formData.get("text") as string | null;

        if (!text || formData.get("intent") !== "create") return;
        
        // Prevent default submission to allow async encryption logic
        event.preventDefault(); 

        const key = encryptKey.trim();
        let textToSend = text;

        if (key) {
            try {
                // 1. Derive key
                const cryptoKey = await deriveKey(key);
                // 2. Encrypt text
                textToSend = await encryptMessage(text, cryptoKey);
            } catch (error) {
                console.error("Encryption failed:", error);
                alert("Encryption failed. Check console for details.");
                return; // Stop form submission on encryption failure
            }
        }

        // Create a new FormData object with the (potentially) encrypted text
        const newFormData = new FormData();
        newFormData.append("text", textToSend);
        newFormData.append("intent", "create");

        // Manually submit the form with the new data
        fetch(form.action, {
            method: form.method,
            body: newFormData,
        }).then(response => {
            if (response.ok) {
                // Clear input fields and trigger a page refresh to update the list
                // For a more advanced setup, you'd use useFetcher or a state update here.
                window.location.reload(); 
            } else {
                console.error("Submission failed:", response.statusText);
            }
        }).catch(error => {
            console.error("Network error during submission:", error);
        });

    }, [encryptKey]); // Recreate if encryptKey changes

    /**
     * Decrypts all notes (both plaintext and encrypted) currently displayed.
     */
    const handleDecryptAll = useCallback(async () => {
        const key = decryptKey.trim();
        if (!key) {
            alert("Please enter a key for decryption.");
            return;
        }

        try {
            const cryptoKey = await deriveKey(key);
            const newDecryptedNotes = await Promise.all(
                decryptedNotes.map(async (note) => {
                    // Only attempt decryption if the note hasn't been successfully decrypted yet
                    if (note.encrypted) {
                        try {
                            const plaintext = await decryptMessage(note.text, cryptoKey);
                            return { id: note.id, text: plaintext, encrypted: false }; // Mark as decrypted
                        } catch (e) {
                            // If decryption fails, keep the original (ciphertext)
                            console.warn(`Decryption failed for note ${note.id}:`, e);
                            return note; 
                        }
                    } 
                    // Per your requirement, decrypt all: plaintext notes are considered decrypted
                    // and will remain as they are, but their 'encrypted' flag is set to false.
                    return { ...note, encrypted: false }; 
                })
            );
            setDecryptedNotes(newDecryptedNotes);
        } catch (error) {
            console.error("Key derivation or decryption process failed:", error);
            alert("Decryption failed. Invalid key or an error occurred.");
        }
    }, [decryptKey, decryptedNotes]);


    return (
        <div className="min-h-screen bg-gray-100 dark:bg-gray-900 py-8 px-4">
            <div className="max-w-2xl mx-auto">
                <h1 className="text-3xl font-bold text-gray-800 dark:text-white mb-8">
                    Notes
                </h1>

                {/* --- CREATE NOTE FORM WITH OPTIONAL ENCRYPT KEY --- */}
                <Form method="post" onSubmit={handleCreateSubmit} className="mb-8 p-4 bg-white dark:bg-gray-800 rounded-lg shadow">
                    <textarea
                        name="text"
                        rows={4}
                        className="w-full rounded-lg border-gray-300 dark:border-gray-700 dark:bg-gray-700 dark:text-white shadow-sm px-4 py-2 resize-y mb-4"
                        placeholder="Add a new note..."
                    />
                    <input
                        type="password"
                        placeholder="Optional Encrypt Key (AES-256)"
                        className="w-full rounded-lg border-gray-300 dark:border-gray-700 dark:bg-gray-700 dark:text-white shadow-sm px-4 py-2 mb-4"
                        value={encryptKey}
                        onChange={(e) => setEncryptKey(e.target.value)}
                        // IMPORTANT: The `name` attribute is omitted to ensure the key is **NEVER** sent to the server.
                    />
                    <button
                        type="submit"
                        name="intent"
                        value="create"
                        className="w-full bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition"
                    >
                        Add Note (Key Used: {encryptKey.length > 0 ? "Yes" : "No"})
                    </button>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                        The key stays in your browser. Encrypting occurs before data is sent.
                    </p>
                </Form>

                {/* --- DECRYPT ALL FIELD --- */}
                <div className="mb-8 p-4 bg-yellow-50 dark:bg-gray-700 rounded-lg shadow border border-yellow-200 dark:border-gray-600">
                    <h2 className="text-xl font-semibold text-gray-800 dark:text-white mb-3">Decrypt All Notes</h2>
                    <input
                        type="password"
                        placeholder="Key to Decrypt All Notes"
                        className="w-full rounded-lg border-gray-300 dark:border-gray-800 dark:bg-gray-800 dark:text-white shadow-sm px-4 py-2 mb-4"
                        value={decryptKey}
                        onChange={(e) => setDecryptKey(e.target.value)}
                        // IMPORTANT: The `name` attribute is omitted to ensure the key is **NEVER** sent to the server.
                    />
                    <button
                        type="button" // Use type="button" to prevent form submission
                        onClick={handleDecryptAll}
                        className="w-full bg-yellow-500 text-white px-4 py-2 rounded-lg hover:bg-yellow-600 transition"
                    >
                        Decrypt All Notes
                    </button>
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400 font-medium">
                        Warning: This attempts to decrypt ALL visible notes, including existing plaintext notes.
                    </p>
                </div>

                {/* --- NOTES LIST --- */}
                <ul className="space-y-4">
                    {decryptedNotes.map((note) => (
                        <li
                            key={note.id}
                            className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow"
                        >
                            <div className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                    <pre className="whitespace-pre-wrap font-sans text-gray-800 dark:text-white">
                                        {note.text}
                                    </pre>
                                    {/* Indicator to show if the text is still encrypted (ciphertext) */}
                                    {note.encrypted && (
                                        <span className="text-sm text-purple-600 dark:text-purple-400 italic">
                                            [Encrypted: Decrypt with key to view]
                                        </span>
                                    )}
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => copyToClipboard(note.text)}
                                        className="text-blue-500 hover:text-blue-700 px-2 py-1 text-sm"
                                        title="Copy note"
                                    >
                                        Copy
                                    </button>
                                    <Form method="post">
                                        <input type="hidden" name="id" value={note.id} />
                                        <button
                                            type="submit"
                                            name="intent"
                                            value="delete"
                                            className="text-red-500 hover:text-red-700 px-2 py-1 text-sm"
                                        >
                                            Delete
                                        </button>
                                    </Form>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}