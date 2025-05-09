import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AxiosError, isAxiosError } from 'axios';
import RecipeCard from '../../components/recipe/AIGeneratedMealCard';
import IngredientsInput from '../../components/GeneratorIngredientsInput';
import type { NutritionalInformation } from '../../types/recipe';
import AOS from 'aos';
import 'aos/dist/aos.css';
import { useToast } from '../../context';
import { favoriteService } from '../../services';
import { recipeApi } from '../../api/apiService';
import { getCsrfHeaders } from '../../utils/csrf';
import { API_PATHS } from '../../api/serviceConfig';
import { useAuth } from '../../context/AuthContext';

interface RecipeDetails {
  ingredientsList: string[];
  equipmentNeeded: string[];
  instructions: string[];
  servingSuggestions: string[];
  nutritionalInformation: NutritionalInformation;
}

interface RecipeResponse {
  id?: string;
  mealName: string;
  ingredientsUsed: string[];
  recipeDetails: RecipeDetails;
  imageUrl: string;
  aiGenerated?: boolean;
  cookingTimeMinutes?: number;
  totalTimeMinutes?: number;
  difficulty?: string;
}

type GeneratedMealResponse = RecipeResponse;

const RecipeGenerator: React.FC = () => {
  // -----------------------------
  // State variables
  // -----------------------------
  const [ingredients, setIngredients] = useState('');
  const [loading, setLoading] = useState(false);
  const [recipe, setRecipe] = useState<GeneratedMealResponse | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);
  const { showToast } = useToast();
  const { isAuthenticated } = useAuth();

  // Helper to ensure consistency with cooking time and difficulty
  const ensureRecipeMetadata = useCallback((recipe: GeneratedMealResponse): GeneratedMealResponse => {
    // Deep copy to avoid mutation issues
    const updatedRecipe = { ...recipe };
    
    // Only generate cooking time if it doesn't exist or is invalid
    if (!updatedRecipe.totalTimeMinutes || updatedRecipe.totalTimeMinutes <= 0) {
      const randomCookingTime = Math.floor(Math.random() * 30) + 15; // 15-45 minutes
      updatedRecipe.totalTimeMinutes = randomCookingTime;
    }
    
    // Set difficulty level if not provided - 70% EASY, 20% MEDIUM, 10% HARD
    if (!updatedRecipe.difficulty) {
      const random = Math.random();
      const randomDifficulty = random < 0.7 ? 'EASY' : random < 0.9 ? 'MEDIUM' : 'HARD';
      updatedRecipe.difficulty = randomDifficulty;
    }
    
    return updatedRecipe;
  }, []);

  // -----------------------------
  // Effects
  // -----------------------------
  useEffect(() => {
    // Initialize AOS animations
    AOS.init({ duration: 1000, easing: 'ease-out-cubic', once: true });
  }, []);

  // Check favorite status when recipe changes
  useEffect(() => {
    if (!recipe?.id) {
      setIsFavorite(false);
      return;
    }
    
    const checkFavoriteStatus = async () => {
      try {
        const recipeId = recipe.id as string;
        console.log('[DEBUG-GENERATOR] Checking favorite status for:', recipeId);
        
        const favoriteStatus = await favoriteService.checkFavorite(recipeId);
        console.log('[DEBUG-GENERATOR] Raw favorite status result:', favoriteStatus, typeof favoriteStatus);
        
        // Force boolean conversion
        const boolStatus = favoriteStatus === true;
        console.log('[DEBUG-GENERATOR] Converted to boolean:', boolStatus);
        
        setIsFavorite(boolStatus);
      } catch (error) {
        console.error('[DEBUG-GENERATOR] Error checking favorite status:', error);
        setIsFavorite(false); // Default to not favorite on error
      }
    };

    checkFavoriteStatus();
  }, [recipe?.id]);

  // -----------------------------
  // Callbacks
  // -----------------------------
  const formatRecipeDetails = useCallback((details: RecipeDetails): string => {
    return `
Ingredients:
${details.ingredientsList.join('\n')}

Equipment Needed:
${details.equipmentNeeded.join('\n')}

Instructions:
${details.instructions.join('\n')}

Serving Suggestions:
${details.servingSuggestions.join('\n')}

Nutritional Information:
Calories: ${details.nutritionalInformation.calories}
Protein: ${details.nutritionalInformation.protein}
Carbohydrates: ${details.nutritionalInformation.carbohydrates}
Fat: ${details.nutritionalInformation.fat}
    `.trim();
  }, []);

  const handleCopyToClipboard = useCallback(() => {
    if (!recipe?.recipeDetails) return;

    navigator.clipboard
      .writeText(formatRecipeDetails(recipe.recipeDetails as RecipeDetails))
      .then(() => {
        showToast('Recipe details copied to clipboard!', 'success');
      })
      .catch(() => {
        showToast('Failed to copy recipe details.', 'error');
      });
  }, [recipe, formatRecipeDetails, showToast]);

  const handleToggleFavorite = useCallback(async (): Promise<boolean> => {
    if (!recipe) {
      console.log('[DEBUG-GENERATOR] Toggle favorite: No recipe to save');
      showToast('No recipe to save', 'error');
      return false;
    }

    // Ensure recipe has proper metadata before saving
    const recipeToSave = ensureRecipeMetadata({...recipe});
    
    // Update recipe state if metadata was added or changed
    if (recipeToSave.totalTimeMinutes !== recipe.totalTimeMinutes || 
        recipeToSave.difficulty !== recipe.difficulty) {
      setRecipe(recipeToSave);
    }

    // Calculate new state
    const newFavoriteState = !isFavorite;
    console.log('[DEBUG-GENERATOR] Toggle favorite: Current:', isFavorite, 'New target state:', newFavoriteState);
    
    // IMPORTANT: Update UI state FIRST for instant feedback
    setIsFavorite(newFavoriteState);
    
    try {
      // New recipe without ID - needs to be saved first
      if (!recipeToSave.id) {
        console.log('[DEBUG-GENERATOR] Toggle favorite: Recipe has no ID, saving first');
        try {
          const recipeId = await favoriteService.saveGeneratedRecipe(recipeToSave);
          console.log('[DEBUG-GENERATOR] Toggle favorite: Recipe saved with ID:', recipeId);
          setRecipe(prev => prev ? {...prev, id: recipeId} : null);
          showToast('Recipe added to favorites!', 'favorite');
          return true;
        } catch (error) {
          console.error('[DEBUG-GENERATOR] Toggle favorite: Error saving recipe:', error);
          // Revert UI on error
          setIsFavorite(false);
          showToast('Database error - unable to save recipe', 'error');
          return false;
        }
      }
      
      // AI-generated recipe being removed
      if (recipeToSave.aiGenerated && newFavoriteState === false) {
        console.log('[DEBUG-GENERATOR] Toggle favorite: Removing AI-generated recipe:', recipeToSave.id);
        try {
          await recipeApi.delete(`${API_PATHS.RECIPE.DELETE}${recipeToSave.id}`);
          console.log('[DEBUG-GENERATOR] Toggle favorite: Recipe removed successfully');
          setRecipe(prev => prev ? {...prev, id: undefined} : null);
          showToast('Recipe removed from favorites', 'success');
          return false;
        } catch (error) {
          console.error('[DEBUG-GENERATOR] Toggle favorite: Error removing recipe:', error);
          // Revert UI on error
          setIsFavorite(true);
          showToast('Database error - unable to remove recipe', 'error');
          return true;
        }
      }
      
      // Regular favorite toggle for existing recipes
      try {
        console.log('[DEBUG-GENERATOR] Toggle favorite: Toggling existing recipe:', recipeToSave.id);
        const success = await favoriteService.toggleFavorite(recipeToSave.id);
        console.log('[DEBUG-GENERATOR] Toggle favorite: Toggle result:', success, typeof success);
        
        // If server response doesn't match our UI state, correct it
        if (success !== newFavoriteState) {
          console.log('[DEBUG-GENERATOR] Toggle favorite: Server returned different state than expected, correcting UI');
          setIsFavorite(success);
        }
        
        showToast(
          success ? 'Recipe added to favorites!' : 'Recipe removed from favorites',
          success ? 'favorite' : 'success'
        );
        
        return success;
      } catch (error) {
        console.error('[DEBUG-GENERATOR] Toggle favorite: Error toggling recipe:', error);
        // Revert UI on error
        setIsFavorite(!newFavoriteState);
        showToast('Database error - unable to update favorites', 'error');
        throw error; // Propagate the error to the FavoriteButton
      }
    } catch (error) {
      console.error('[DEBUG-GENERATOR] Toggle favorite: Unexpected error:', error);
      // Revert UI on error
      setIsFavorite(!newFavoriteState);
      showToast('Database error - unexpected problem', 'error');
      throw error; // Propagate the error to the FavoriteButton
    }
  }, [recipe, showToast, isFavorite, ensureRecipeMetadata]);

  const handleApiError = useCallback((err: unknown) => {
    console.error('Error generating recipe:', err);
    
    if (isAxiosError(err)) {
      const axiosError = err as AxiosError<any>;
      let errorMessage = '';
      
      // Handle response errors
      if (axiosError.response) {
        // Check if this is a non-food ingredient error first
        if (axiosError.response.data?.message && 
            axiosError.response.data.message.includes('Cannot create recipe with non-food items')) {
          showToast(axiosError.response.data.message, 'error', 6000);
          return;
        }
        
        // Handle other status codes
        switch (axiosError.response.status) {
          case 400:
            errorMessage = 'Please check your ingredients and try again.';
            break;
          case 401:
            errorMessage = 'Your session has expired. Please log in again.';
            break;
          case 403:
            errorMessage = 'Please log in to generate recipes.';
            break;
          case 500:
            errorMessage = 'The recipe service is temporarily unavailable.';
            break;
          default:
            errorMessage = axiosError.response.data?.message || 'Error generating recipe.';
        }
      } else if (axiosError.request) {
        // Network error
        errorMessage = 'Unable to connect to the recipe service.';
      } else {
        // Default error
        errorMessage = 'Error generating recipe.';
      }
      
      showToast(errorMessage, 'error', 6000);
      return;
    }
    
    // For non-axios errors
    showToast(err instanceof Error ? err.message : 'An unexpected error occurred.', 'error', 6000);
  }, [showToast]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      
      setLoading(true);
      setRecipe(null);

      // Validate ingredients
      const ingredientsArray = ingredients
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

      if (ingredientsArray.length === 0) {
        showToast('Please enter at least one ingredient.', 'error');
        setLoading(false);
        return;
      }

      if (ingredientsArray.some(item => item.length < 2)) {
        showToast('Please enter valid ingredients (at least 2 characters each).', 'error');
        setLoading(false);
        return;
      }

      // Check authentication
      if (!localStorage.getItem('auth_token')) {
        showToast('Please log in to generate recipes.', 'error');
        setLoading(false);
        return;
      }

      try {
        const response = await recipeApi.post(API_PATHS.RECIPE.GENERATE, ingredientsArray);
        const data = response.data;
        console.log('[RecipeGenerator] Recipe data received:', data);
        
        // Check for error response
        if (data.error && data.error.includes('non-food items')) {
          showToast(`${data.error}${data.nonFoodItems ? ': ' + data.nonFoodItems.join(', ') : ''}`, 'error', 6000);
          setLoading(false);
          return;
        }
        
        // Transform the API response
        const recipeData: GeneratedMealResponse = {
          mealName: data.title || 'Unnamed Recipe',
          ingredientsUsed: data.ingredients || [],
          imageUrl: data.imageUrl || '',
          aiGenerated: true,
          // Use totalTimeMinutes directly
          totalTimeMinutes: data.totalTimeMinutes,
          difficulty: data.difficulty,
          recipeDetails: {
            ingredientsList: data.ingredients || [],
            equipmentNeeded: [],
            instructions: data.instructions 
              ? data.instructions.split('\n').map((instruction: string) => 
                  instruction.trim().replace(/^(\d+\.|\d+\)|\d+|Step \d+:)\s+/i, ''))
              : [],
            servingSuggestions: data.servingSuggestions 
              ? [data.servingSuggestions.trim()] 
              : data.description ? [data.description.trim()] : ['Enjoy your meal!'],
            nutritionalInformation: {
              calories: String(data.macros?.calories || ''),
              protein: String(data.macros?.proteinGrams || '') + 'g',
              carbohydrates: String(data.macros?.carbsGrams || '') + 'g',
              fat: String(data.macros?.fatGrams || '') + 'g',
            },
          },
        };
        
        // Deep copy for safety before ensuring metadata 
        const enrichedRecipeData = ensureRecipeMetadata({...recipeData});
        
        console.log('[RecipeGenerator] Recipe data mapping details:', { 
          originalData: {
            totalTimeMinutes: data.totalTimeMinutes,
            difficulty: data.difficulty
          },
          mappedData: {
            totalTimeMinutes: recipeData.totalTimeMinutes,
            difficulty: recipeData.difficulty
          },
          enrichedData: {
            totalTimeMinutes: enrichedRecipeData.totalTimeMinutes,
            difficulty: enrichedRecipeData.difficulty,
            wasEnriched: enrichedRecipeData.totalTimeMinutes !== recipeData.totalTimeMinutes || 
                         enrichedRecipeData.difficulty !== recipeData.difficulty
          }
        });
        
        setRecipe(enrichedRecipeData);
        showToast('Recipe generated successfully!', 'success');
      } catch (err: unknown) {
        handleApiError(err);
      } finally {
        setLoading(false);
      }
    },
    [ingredients, showToast, handleApiError, ensureRecipeMetadata]
  );

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <div className="w-full overflow-x-hidden max-w-6xl mx-auto px-4 py-10">
      <div className="relative w-full">
        <div 
          className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-amber-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 rounded-3xl opacity-50"
          aria-hidden="true"
        />

        <div className="relative w-full max-w-3xl mx-auto bg-white dark:bg-gray-800 bg-opacity-90 dark:bg-opacity-90 backdrop-blur-sm rounded-3xl shadow-xl p-8 border border-gray-200 dark:border-gray-700">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-700 dark:from-blue-400 dark:to-indigo-300 text-center mb-8">
            Discover Your Recipe
          </h1>

          {/* Input form */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <IngredientsInput ingredients={ingredients} onChange={setIngredients} />
            <button
              type="submit"
              disabled={!ingredients.trim() || loading}
              className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-500 dark:to-indigo-500 text-white font-bold text-xl shadow-md transition-all duration-300 hover:scale-[1.02] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {loading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Generating Recipe...
                </>
              ) : (
                'Generate Recipe'
              )}
            </button>
          </form>

          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center justify-center mt-12">
              <div className="w-16 h-16 border-t-4 border-b-4 border-blue-500 rounded-full animate-spin mb-4"></div>
              <p className="text-lg text-gray-600 dark:text-gray-300">Creating your perfect recipe...</p>
            </div>
          )}

          {/* Generated recipe card */}
          {recipe && !loading && (
            <div data-aos="fade-up" className="mt-8">
              <RecipeCard
                key={`recipe-${recipe.id}-${isFavorite ? 'favorite' : 'not-favorite'}`}
                recipe={recipe}
                isFavorite={isFavorite}
                onCopy={handleCopyToClipboard}
                onToggleFavorite={handleToggleFavorite}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RecipeGenerator;
