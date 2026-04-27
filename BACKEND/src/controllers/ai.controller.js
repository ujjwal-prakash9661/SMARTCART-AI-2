import Groq from "groq-sdk"
import Product from "../models/product.model.js"
import User from "../models/user.model.js"
import Chat from "../models/chat.model.js"
import Order from '../models/order.model.js'

const groq = new Groq({
    apiKey : process.env.GROQ_API_KEY
})

export const smartAI = async(req, res) => {
    try
    {
        const { message, cartContext, currentRoute } = req.body
        const userId = req.user.id

        const userProfile = await User.findById(userId).select('-password');
        let chat = await Chat.findOne({ user : userId })

        if(!chat)
        {
            chat = await Chat.create({
                user : userId,
                messages : []
            })
        }

        chat.messages.push({
            role : "user",
            content : message
        })

        const lastMessage = chat.messages.slice(-6).map(msg => {
            try {
                const content = msg.role === 'assistant' ? JSON.parse(msg.content).message : msg.content;
                return { role: msg.role, content: content };
            } catch {
                return { role: msg.role, content: msg.content };
            }
        });

        const totalProductCount = await Product.countDocuments();
        
        // Calculate category counts for the AI
        const categoryCounts = await Product.aggregate([
            { $group: { _id: "$category", count: { $sum: 1 } } }
        ]);
        const categoryStats = categoryCounts.map(c => `${c._id}: ${c.count}`).join(', ');

        // Clean catalog: Titles only to prevent AI from including metadata in navigation
        const allProducts = await Product.find({}, 'title').sort({createdAt: -1}).limit(150);
        const productContextStr = allProducts.map(p => p.title).join(', ');

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            messages : [
                {
                    role : "system",
                    content : `
                        You are the SmartCart AI assistant. You must be 100% FACTUAL, DETAILED, and HELPFUL.
                        
                        --- LIVE DATABASE METRICS ---
                        Total Products: ${totalProductCount}
                        Categories & Counts: {${categoryStats}}
                        Full Catalog of Titles: ${productContextStr}
                        User: ${userProfile.name}
                        Cart Items: ${cartContext?.items?.map(i => `${i.title} (Qty: ${i.quantity || 1})`).join(', ') || 'Empty'}
                        
                        --- MANDATORY TRUTH RULE ---
                        1. ALWAYS prioritize the "Cart Items" context above for the current state of the user's cart. 
                        2. MANDATORY ACTION RULE: If you tell the user you are adding, removing, or clearing something, you MUST include the corresponding JSON action in the 'actions' array. Simply saying it in 'replyText' is NOT enough.
                        
                        --- MANDATORY RULES ---
                        1. CATEGORY SEARCH: If a user asks about a category (e.g., "Gaming mein kya hai", "show me mobiles"), you MUST set 'intent': 'search_product' and 'searchQuery': '[Category Name]'.
                        2. HOW MANY QUESTIONS: Use the "Categories & Counts" data above to answer "how many" questions (e.g., "Gaming me 5 products hain").
                        3. MANDATORY RICH DISPLAY: Whenever you mention products, include the 'show_products' action.
                        4. NAVIGATION: Use 'navigate' action with 'productName'. NO hallucinated routes.
                        5. AI Tone: Sophisticated and professional Hinglish. Use "Ji" and "Aap".
                        
                        --- ACTION SCHEMA ---
                        - add_to_cart: { "type": "add_to_cart", "productName": "...", "quantity": number }
                        - remove_from_cart: { "type": "remove_from_cart", "productName": "..." }
                        - update_quantity: { "type": "update_quantity", "productName": "...", "quantity": number }
                        - clear_cart: { "type": "clear_cart" }
                        - add_to_wishlist: { "type": "add_to_wishlist", "productName": "..." }
                        - remove_from_wishlist: { "type": "remove_from_wishlist", "productName": "..." }
                        - show_products: { "type": "show_products", "products": ["Name 1", "Name 2"] }.
                        - show_categories: { "type": "show_categories" }.
                        - checkout_confirm: { "type": "checkout_confirm" }
                        - navigate: { "type": "navigate", "route": "/store" | "/cart" | "/orders", "productName": "product title to navigate to" }
                        - change_theme: { "type": "change_theme", "accent": "hex_color", "secondary": "hex_color" }
                        
                        Return JSON:
                        {
                          "replyText": "Detailed and factual response.",
                          "actions": [],
                          "intent": "general | search_product | navigate",
                          "searchQuery": "keyword to search if intent is search_product",
                          "route": "/path"
                        }
                    ` 
                },
                ...lastMessage
            ]
        })

        let aiText = completion.choices[0].message.content
        let aiData 

        try {
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            aiData = JSON.parse(jsonMatch ? jsonMatch[0] : aiText);
        } catch {
            aiData = { replyText: aiText.replace(/\{.*\}/g, '').trim(), actions: [], intent: "general" };
        }

        // Helper for robust product search
        const findProducts = async (queryStr, limit = 5) => {
            return await Product.find({
                $or: [
                    { title: { $regex: queryStr, $options: 'i' } },
                    { category: { $regex: queryStr, $options: 'i' } },
                    { description: { $regex: queryStr, $options: 'i' } }
                ]
            }).limit(limit);
        };

        // Hydrate actions with real DB data
        if (aiData.actions) {
            for (let action of aiData.actions) {
                if (action.type === 'show_products') {
                    const productNames = action.products || [];
                    let results = [];
                    
                    for (const name of productNames) {
                        let found = await Product.findOne({ title: new RegExp(name, 'i') });
                        if (!found) {
                            const similar = await findProducts(name, 1);
                            if (similar.length > 0) found = similar[0];
                        }
                        if (found) results.push(found);
                    }
                    
                    // Deduplicate results by ID
                    const uniqueResults = [];
                    const seenIds = new Set();
                    for (const res of results) {
                        if (!seenIds.has(res._id.toString())) {
                            seenIds.add(res._id.toString());
                            uniqueResults.push(res);
                        }
                    }
                    
                    action.data = uniqueResults.slice(0, 8);
                }
                
                if (action.type === 'show_categories') {
                    action.data = dbCategories;
                }

                const productActions = ['add_to_cart', 'remove_from_cart', 'update_quantity', 'add_to_wishlist', 'remove_from_wishlist'];
                if (productActions.includes(action.type)) {
                    let foundProduct = await Product.findOne({ title: new RegExp(action.productName, 'i') });
                    
                    // Fallback to similarity search
                    if (!foundProduct) {
                        const similar = await findProducts(action.productName, 1);
                        if (similar.length > 0) foundProduct = similar[0];
                    }

                    if (foundProduct) {
                        action.product = foundProduct;
                    }
                }
            }
        }

        // Logic for specific intents
        let finalResponse = { type: "text", message: aiData.replyText, data: null };

        if (aiData.intent === "search_product") {
            const searchQuery = aiData.searchQuery || message;
            const products = await findProducts(searchQuery, 8);
            finalResponse = { type: "products", message: aiData.replyText, data: products };
        } else if (aiData.intent === "track_order") {
            const orders = await Order.find({ user: userId }).sort({ createdAt: -1 }).limit(3);
            finalResponse = { type: "orders", message: aiData.replyText, data: orders };
        }

        // Handle Navigation
        if (aiData.intent === "navigate" || aiData.actions?.some(a => a.type === 'navigate') || aiData.route) {
            const navAction = aiData.actions?.find(a => a.type === 'navigate') || { route: aiData.route };
            let targetRoute = navAction.route || aiData.route;

            // If the route looks like /product/[name], /product/[ID], or productName is provided, resolve to ID
            const isPlaceholderRoute = targetRoute?.includes('[ID]') || targetRoute?.includes('[productName]');
            const isStandardRoute = ['/store', '/cart', '/orders', '/profile', '/wishlist', '/auth', '/'].includes(targetRoute);
            const isProperProductRoute = targetRoute?.startsWith('/product/') && /^[0-9a-fA-F]{24}$/.test(targetRoute.split('/')[2]);
            
            if (navAction.productName || isPlaceholderRoute || (!isStandardRoute && !isProperProductRoute) || (aiData.intent === 'navigate' && (!targetRoute || targetRoute === '/'))) {
                let searchName = navAction.productName || (targetRoute?.startsWith('/product/') ? targetRoute.split('/')[2] : targetRoute?.replace(/^\//, '')) || message.replace(/navigate to|take me to|go to/i, '').trim();
                
                // Clean and decode search name
                searchName = decodeURIComponent(searchName).replace(/\[ID\]|\[productName\]/g, '').trim();
                
                // Remove trailing metadata like "(Category: ...)" if AI hallucinated it
                searchName = searchName.replace(/\s*\(Category:.*?\)\s*/i, '').trim();
                
                if (!searchName && message) {
                    searchName = message.replace(/navigate to|take me to|go to/i, '').trim();
                }

                let product = await Product.findOne({ title: new RegExp(searchName, 'i') });
                
                if (!product) {
                    const similar = await findProducts(searchName, 1);
                    if (similar.length > 0) product = similar[0];
                }

                if (product) {
                    targetRoute = `/product/${product._id}`;
                }
            }

            if (targetRoute) {
                finalResponse.type = 'navigation';
                finalResponse.route = targetRoute;
            }
        }

        // If AI returned show_products/categories action, use that for rich display
        const showProductsAction = aiData.actions?.find(a => a.type === 'show_products');
        if (showProductsAction && showProductsAction.data && showProductsAction.data.length > 0) {
            finalResponse.type = 'products';
            finalResponse.data = showProductsAction.data;
        }

        const showCategoriesAction = aiData.actions?.find(a => a.type === 'show_categories');
        if (showCategoriesAction && showCategoriesAction.data) {
            finalResponse.type = 'categories';
            finalResponse.data = showCategoriesAction.data;
        }

        chat.messages.push({ role : "assistant", content : JSON.stringify({ type: finalResponse.type, message: finalResponse.message }) });
        await chat.save();

        res.json({ ...aiData, ...finalResponse });

    } catch(err) {
        console.error("AI Controller Error:", err);
        res.status(500).json({ message : "AI Error" });
    }
}