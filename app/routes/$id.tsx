import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
} from "@remix-run/cloudflare";
import { useLoaderData, Form } from "@remix-run/react";
import { TodoManager } from "~/to-do-manager";

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

export default function () {
    const { notes } = useLoaderData<typeof loader>();

    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    return (
        <html lang="en">
            <head>
                {/* This ensures CSS is loaded before any content renders */}
                <style dangerouslySetInnerHTML={{
                    __html: `
                        /* Critical CSS for preventing overflow */
                        * {
                            box-sizing: border-box;
                        }
                        
                        body {
                            margin: 0;
                            padding: 0;
                            opacity: 0;
                            transition: opacity 0.2s ease-in;
                        }
                        
                        body.loaded {
                            opacity: 1;
                        }
                        
                        .note-text {
                            word-break: break-word;
                            overflow-wrap: break-word;
                            word-wrap: break-word;
                            hyphens: auto;
                            max-width: 100%;
                            overflow: hidden;
                        }
                        
                        /* Prevent horizontal overflow */
                        .note-container {
                            max-width: 100%;
                            overflow: hidden;
                        }
                    `
                }} />
                
                {/* Link to external CSS */}
                <link 
                    rel="stylesheet" 
                    href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" 
                    integrity="sha512-wnea99uKIC3TJF7v4eKk4Y+lMz2Mklv18+r4na2Gn1abDRPPOeef95xTzdwGD9e6zXJBteMIhZ1+68QC5byJZw==" 
                    crossOrigin="anonymous" 
                    referrerPolicy="no-referrer" 
                />
                
                {/* Script to ensure body is only visible after CSS loads */}
                <script dangerouslySetInnerHTML={{
                    __html: `
                        // Mark body as loaded after CSS is ready
                        document.addEventListener('DOMContentLoaded', () => {
                            // Ensure all CSS is loaded
                            Promise.all(
                                Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                                    .map(link => {
                                        if (link.sheet) return Promise.resolve();
                                        return new Promise(resolve => {
                                            link.addEventListener('load', resolve);
                                        });
                                    })
                            ).then(() => {
                                document.body.classList.add('loaded');
                            });
                        });
                    `
                }} />
            </head>
            
            <body className="min-h-screen bg-gray-100 dark:bg-gray-900">
                <div className="py-8 px-4">
                    <div className="max-w-2xl mx-auto">
                        <h1 className="text-3xl font-bold text-gray-800 dark:text-white mb-8">
                            Notes
                        </h1>

                        <Form method="post" className="mb-8">
                            <textarea
                                name="text"
                                rows={4}
                                className="w-full rounded-lg border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white shadow-sm px-4 py-2 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                placeholder="Add a new note..."
                            />
                            <button
                                type="submit"
                                name="intent"
                                value="create"
                                className="mt-2 bg-blue-500 text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                            >
                                Add Note
                            </button>
                        </Form>

                        <ul className="space-y-4">
                            {notes.map((note) => (
                                <li
                                    key={note.id}
                                    className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow note-container"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex-1 min-w-0"> {/* Ensures text container respects flex constraints */}
                                            <pre className="font-sans text-gray-800 dark:text-white note-text whitespace-pre-wrap break-words max-w-full">
                                                {note.text}
                                            </pre>
                                        </div>
                                        <div className="flex gap-2 flex-shrink-0">
                                            <button
                                                onClick={() => copyToClipboard(note.text)}
                                                className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded transition"
                                                title="Copy note"
                                                type="button"
                                            >
                                                Copy
                                            </button>
                                            <Form method="post" className="inline">
                                                <input type="hidden" name="id" value={note.id} />
                                                <button
                                                    type="submit"
                                                    name="intent"
                                                    value="delete"
                                                    className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 rounded transition"
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
            </body>
        </html>
    );
}