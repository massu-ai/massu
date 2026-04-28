from django.urls import path
from .views import home, widget_list, WidgetListView


urlpatterns = [
    path("", home),
    path("widgets/", widget_list),
    path("widget-list/", WidgetListView.as_view()),
]
